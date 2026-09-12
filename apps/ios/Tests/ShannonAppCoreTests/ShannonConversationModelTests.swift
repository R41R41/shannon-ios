import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonConversationModelTests: XCTestCase {
    func testOrganizeSessionAttachesToReplyAndAppliesOnlyAfterReview() async {
        let client = OrganizeClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.draft = "整理して"

        await model.sendDraft()

        let replyID = UUID(uuidString: TestFixtures.organizeMessageID)
        XCTAssertEqual(model.messages.last?.id, replyID)
        XCTAssertEqual(model.organizeSession(sourceMessageID: replyID!)?.items.first?.decision, .proposed)
        var applyCount = await client.currentApplyCount()
        XCTAssertEqual(applyCount, 0)

        await model.decideOrganizeItem(
            sessionID: TestFixtures.organizeSessionID,
            itemID: TestFixtures.organizeItemID,
            decision: .accepted,
            title: "確認済みTask",
            details: "確認済みの内容"
        )
        XCTAssertEqual(model.organizeSessions.first?.items.first?.title, "確認済みTask")
        applyCount = await client.currentApplyCount()
        XCTAssertEqual(applyCount, 0)

        await model.applyOrganizeSession(TestFixtures.organizeSessionID)
        applyCount = await client.currentApplyCount()
        XCTAssertEqual(applyCount, 1)
        XCTAssertEqual(model.organizeSessions.first?.state, .applied)
        XCTAssertEqual(model.organizeSessions.first?.items.first?.result?.resourceType, "task")
    }

    func testOrganizePhaseTwoLoadsCandidatesAndKeepsUpdateTargetThroughReview() async {
        let client = OrganizeClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.draft = "整理して"
        await model.sendDraft()

        await model.searchVoyagerTasks(itemID: TestFixtures.organizeItemID, query: "既存Task")
        let target = model.voyagerTaskCandidatesByItemID[TestFixtures.organizeItemID]?.first
        XCTAssertEqual(target?.revision, 4)
        XCTAssertEqual(model.voyagerProjects.first?.title, "Shannon")

        await model.decideOrganizeItem(
            sessionID: TestFixtures.organizeSessionID,
            itemID: TestFixtures.organizeItemID,
            decision: .accepted,
            title: "既存Taskを更新する",
            details: "実機確認結果を追記する",
            operation: .update,
            target: target,
            projectIds: ["project-shannon"]
        )

        let reviewed = model.organizeSessions.first?.items.first
        XCTAssertEqual(reviewed?.operation, .update)
        XCTAssertEqual(reviewed?.target?.id, "task-existing")
        XCTAssertEqual(reviewed?.projectIds, ["project-shannon"])
    }

    func testGeneratedTitleArrivesWithAssistantReplyAndRestoresFromDisplayCache() async {
        let scopeKey = "title-test-\(UUID().uuidString)"
        defer { UserDefaults.standard.removeObject(forKey: "shannon.conversation-cache.v1.\(scopeKey)") }
        let client = TitleClient()
        let model = ShannonConversationModel(scopeKey: scopeKey, client: client, usesDisplayCache: true)
        await model.loadThreads(force: true)
        model.draft = "週末は京都に行きたい"
        let sending = Task { await model.sendDraft() }
        await client.waitForSend()

        XCTAssertEqual(model.selectedThread?.title, "新しいトーク")
        XCTAssertEqual(model.messages.map(\.role), [.user])
        await client.completeSend()
        await sending.value

        XCTAssertEqual(model.messages.map(\.role), [.user, .shannon])
        XCTAssertEqual(model.selectedThread?.title, "京都の庭園巡り")
        XCTAssertEqual(model.selectedThread?.messageCount, 2)
        XCTAssertEqual(model.selectedThread?.summary, "京都旅行を計画中。庭園を巡る案が出ている。")
        XCTAssertEqual(model.selectedThread?.sections, ["候補", "次の確認"])
        let listLoads = await client.listLoads
        XCTAssertEqual(listLoads, 1, "The title must not wait for another thread-list request")
        XCTAssertFalse(model.isSending)

        let restored = ShannonConversationModel(scopeKey: scopeKey, client: client, usesDisplayCache: true)
        XCTAssertEqual(restored.selectedThread?.title, "京都の庭園巡り")
        XCTAssertEqual(restored.messages.map(\.text), model.messages.map(\.text))
    }

    func testSourceAttributionRestoresFromDisplayCache() throws {
        let suiteName = "shannon-source-cache-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let cache = ShannonConversationCache(defaults: defaults)
        let attribution = ShannonSourceAttributionDTO(
            title: "Hacker News",
            url: "https://example.com/agents",
            reason: "今日の関心と近いから。"
        )
        let message = ConversationMessage(
            role: .shannon,
            text: "気になる記事を見つけた。",
            sourceAttribution: attribution
        )
        cache.save(
            ShannonConversationCache.Snapshot(
                threads: [],
                selectedThreadId: "thread-a",
                histories: ["thread-a": [ShannonConversationCache.CachedMessage(message)]],
                state: nil
            ),
            scopeKey: "owner-a"
        )

        let restored = try XCTUnwrap(cache.load(scopeKey: "owner-a"))
        XCTAssertEqual(restored.histories["thread-a"]?.first?.message.sourceAttribution, attribution)
    }

    func testManualTitleEditedDuringSendWinsOverEarlierChatResponse() async {
        for title in ["自分の旅行メモ", "新しいトーク"] {
            let client = TitleClient()
            let model = ShannonConversationModel(client: client, usesDisplayCache: false)
            await model.loadThreads(force: true)
            model.draft = "京都に行きたい"
            let sending = Task { await model.sendDraft() }
            await client.waitForSend()
            let renamed = await model.renameThread("test-thread", title: title)
            XCTAssertTrue(renamed)
            await client.completeSend()
            await sending.value

            XCTAssertEqual(model.selectedThread?.title, title)
            XCTAssertEqual(model.messages.map(\.role), [.user, .shannon])
            let renamedAgain = await model.renameThread("test-thread", title: "あとから編集")
            XCTAssertTrue(renamedAgain)
            XCTAssertEqual(model.selectedThread?.title, "あとから編集")
        }
    }

    func testOlderThreadListCannotOverwriteGeneratedOrManuallyEditedTitle() async {
        let client = TitleClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        await model.loadThreads(force: true)
        await client.delayNextList()
        let refreshing = Task { await model.loadThreads(force: true) }
        await client.waitForList()

        model.draft = "京都に行きたい"
        let sending = Task { await model.sendDraft() }
        await client.waitForSend()
        await client.completeSend()
        await sending.value
        await client.completeList()
        await refreshing.value
        XCTAssertEqual(model.selectedThread?.title, "京都の庭園巡り")

        await client.delayNextList()
        let nextRefresh = Task { await model.loadThreads(force: true) }
        await client.waitForList()
        let renamed = await model.renameThread("test-thread", title: "自分のタイトル")
        XCTAssertTrue(renamed)
        await client.completeList()
        await nextRefresh.value
        XCTAssertEqual(model.selectedThread?.title, "自分のタイトル")
    }

    func testFailedFirstSendKeepsDefaultTitleAndRetryAppliesGeneratedTitle() async {
        let client = TitleClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        await model.loadThreads(force: true)
        model.draft = "京都に行きたい"
        let sending = Task { await model.sendDraft() }
        await client.waitForSend()
        await client.failSend()
        await sending.value
        XCTAssertEqual(model.selectedThread?.title, "新しいトーク")
        XCTAssertEqual(model.messages.map(\.role), [.user])
        XCTAssertEqual(model.messages.first?.deliveryState, .failed)

        let retrying = Task { await model.retryLastFailed() }
        await client.waitForSend()
        await client.completeSend()
        await retrying.value
        XCTAssertEqual(model.messages.map(\.role), [.user, .shannon])
        XCTAssertEqual(model.selectedThread?.title, "京都の庭園巡り")
    }

    func testChatResponseDecodesWithAndWithoutThreadMetadata() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let legacy = try decoder.decode(ChatResponseDTO.self, from: encoder.encode(TestFixtures.chatResponse()))
        XCTAssertNil(legacy.thread)
        let thread = ChatThreadDTO(
            threadId: "test-thread", title: "京都の庭園巡り", createdAt: "2026-09-05T00:00:00Z",
            updatedAt: "2026-09-05T00:00:01Z", messageCount: 2
        )
        let current = try decoder.decode(ChatResponseDTO.self, from: encoder.encode(TestFixtures.chatResponse(thread: thread)))
        XCTAssertEqual(current.thread, thread)
    }

    func testTimelineAddsOneQuietDividerPerCalendarDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let messages = [
            ConversationMessage(role: .user, text: "一日目", sentAt: Date(timeIntervalSince1970: 1_788_307_200)),
            ConversationMessage(role: .shannon, text: "一日目の返事", sentAt: Date(timeIntervalSince1970: 1_788_307_260)),
            ConversationMessage(role: .user, text: "二日目", sentAt: Date(timeIntervalSince1970: 1_788_393_600)),
        ]

        let items = ShannonConversationTimeline.items(from: messages, calendar: calendar)

        XCTAssertEqual(items.count, 5)
        XCTAssertEqual(items.filter {
            if case .day = $0 { return true }
            return false
        }.count, 2)
    }

    func testSuccessfulTurnAppendsBothMessagesAndState() async {
        let response = TestFixtures.chatResponse(version: 3, reply: "聞いてるよ", expression: .calm)
        let model = ShannonConversationModel(client: StubClient(response: response))
        model.draft = "こんにちは"

        await model.sendDraft()

        XCTAssertEqual(model.messages.map(\.text), ["こんにちは", "聞いてるよ"])
        XCTAssertEqual(model.messages.first?.deliveryState, .sent)
        XCTAssertEqual(model.messages.last?.emotionSnapshot?.expression, .calm)
        XCTAssertEqual(model.messages.last?.emotionSnapshot?.stateVersion, 3)
        XCTAssertEqual(model.state?.version, 3)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isSending)
    }

    func testEmptyDraftDoesNotCallClientOrAppend() async {
        let model = ShannonConversationModel(client: StubClient(response: TestFixtures.chatResponse()))
        model.draft = "   "

        await model.sendDraft()

        XCTAssertTrue(model.messages.isEmpty)
    }

    func testAttachmentOnlyTurnUsesVisibleFileNameAndSeparateAttachmentPayload() async {
        let client = AttachmentClient()
        let model = ShannonConversationModel(client: client)
        let attachment = ShannonChatAttachmentDTO(
            name: "plan.md",
            mimeType: "text/markdown",
            text: "# 非公開の計画"
        )

        await model.sendDraft(attachments: [attachment])

        let captured = await client.captured
        XCTAssertEqual(captured?.attachments, [attachment])
        XCTAssertEqual(captured?.message, "この添付資料を確認してください。\n\n📎 plan.md")
        XCTAssertEqual(model.messages.first?.text, captured?.message)
        XCTAssertEqual(model.messages.map(\.role), [.user, .shannon])
    }

    func testWebSearchTurnUsesExplicitFlagWithoutChangingVisibleMessage() async {
        let client = AttachmentClient()
        let model = ShannonConversationModel(client: client)
        model.draft = "今日のOpenAI情報を調べて"

        await model.sendDraft(webSearch: true)

        let captured = await client.captured
        XCTAssertEqual(captured?.message, "今日のOpenAI情報を調べて")
        XCTAssertEqual(captured?.webSearch, true)
        XCTAssertEqual(model.messages.first?.text, "今日のOpenAI情報を調べて")
    }

    func testGeneratedArtifactsRemainAttachedToTheAssistantReply() async {
        let artifact = ShannonGeneratedArtifactDTO(
            name: "plan.md",
            mimeType: "text/markdown",
            content: "# Plan\n",
            summary: "実装計画"
        )
        let model = ShannonConversationModel(client: StubClient(
            response: TestFixtures.chatResponse(reply: "用意したよ", artifacts: [artifact])
        ))
        model.draft = "Markdownファイルにして"

        await model.sendDraft()

        XCTAssertEqual(model.messages.last?.role, .shannon)
        XCTAssertEqual(model.messages.last?.artifacts, [artifact])
    }

    func testGeneratedArtifactFilenameCannotEscapeTheChosenFolder() {
        XCTAssertEqual(
            ShannonGeneratedArtifact.safeFilename("../unsafe/plan", mimeType: "text/markdown"),
            "..-unsafe-plan.md"
        )
        XCTAssertEqual(
            ShannonGeneratedArtifact.safeFilename("   ", mimeType: "application/json"),
            "shannon-artifact.json"
        )
    }

    func testSharedAttachmentLoaderReadsSupportedUTF8Text() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-shared-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("notes.md")
        try Data("# 設計メモ\n本文".utf8).write(to: url)

        XCTAssertEqual(
            try ShannonChatAttachmentLoader.load(urls: [url]),
            [ShannonChatAttachmentDTO(name: "notes.md", mimeType: "text/markdown", text: "# 設計メモ\n本文")]
        )
    }

    func testSharedAttachmentLoaderRejectsDuplicateAndOversizedFiles() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-shared-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let duplicate = folder.appendingPathComponent("notes.txt")
        try Data("本文".utf8).write(to: duplicate)
        let large = folder.appendingPathComponent("large.txt")
        try Data(repeating: 65, count: ShannonChatAttachmentLimits.maximumBytesPerFile + 1).write(to: large)

        XCTAssertThrowsError(try ShannonChatAttachmentLoader.load(
            urls: [duplicate],
            existing: [.init(name: "notes.txt", mimeType: "text/plain", text: "既存")]
        )) { error in
            XCTAssertEqual(error as? ShannonChatAttachmentError, .duplicateName("notes.txt"))
        }
        XCTAssertThrowsError(try ShannonChatAttachmentLoader.load(urls: [large])) { error in
            XCTAssertEqual(error as? ShannonChatAttachmentError, .fileTooLarge("large.txt"))
        }
    }

    func testThreadSearchIncludesTitleSummaryAndSections() {
        let threads = [
            ChatThreadDTO(
                threadId: "design",
                title: "Clear Signal",
                createdAt: "2026-09-12T00:00:00Z",
                updatedAt: "2026-09-12T00:00:00Z",
                messageCount: 4,
                summary: "入力欄の余白を整理",
                sections: ["生成物の保存"]
            ),
            ChatThreadDTO(
                threadId: "other",
                title: "買い物",
                createdAt: "2026-09-12T00:00:00Z",
                updatedAt: "2026-09-12T00:00:00Z",
                messageCount: 1
            ),
        ]

        XCTAssertEqual(ShannonThreadSearch.matches(threads, query: "ＣＬＥＡＲ").map(\.threadId), ["design"])
        XCTAssertEqual(ShannonThreadSearch.matches(threads, query: "余白").map(\.threadId), ["design"])
        XCTAssertEqual(ShannonThreadSearch.matches(threads, query: "生成物").map(\.threadId), ["design"])
        XCTAssertEqual(ShannonThreadSearch.matchContext(for: threads[0], query: "生成物"), "生成物の保存")
    }

    func testEachReplyKeepsItsExpressionSnapshot() async {
        let client = SequenceClient(results: [
            .success(TestFixtures.chatResponse(version: 1, reply: "それは嬉しい", expression: .joyful)),
            .success(TestFixtures.chatResponse(version: 2, reply: "少し休もうか", expression: .tender)),
        ])
        let model = ShannonConversationModel(client: client)

        model.draft = "できた！"
        await model.sendDraft()
        model.draft = "ちょっと疲れた"
        await model.sendDraft()

        let replies = model.messages.filter { $0.role == .shannon }
        XCTAssertEqual(replies.map(\.emotionSnapshot?.expression), [.joyful, .tender])
        XCTAssertEqual(model.currentExpression, .tender)
    }

    func testRetryDoesNotDuplicateFailedUserMessage() async {
        let client = SequenceClient(results: [
            .failure(TestFailure.offline),
            .success(TestFixtures.chatResponse(version: 1, reply: "戻ったよ", expression: .calm)),
        ])
        let model = ShannonConversationModel(client: client)

        model.draft = "聞こえる？"
        await model.sendDraft()
        XCTAssertEqual(model.messages.count, 1)
        XCTAssertEqual(model.messages.first?.deliveryState, .failed)

        await model.retryLastFailed()

        XCTAssertEqual(model.messages.map(\.text), ["聞こえる？", "戻ったよ"])
        XCTAssertEqual(model.messages.first?.deliveryState, .sent)
        XCTAssertNil(model.errorMessage)
    }

    func testLoadsPersistedConversationAndExpressionOnce() async {
        let history = ConversationHistoryResponseDTO(
            threadId: "persisted-thread",
            messages: [
                StoredConversationMessageDTO(
                    id: "26F3D19A-A881-40C4-99BB-6C738E86CC05",
                    role: "user",
                    content: "昨日の話",
                    observedAt: "2026-08-30T21:00:00.000Z",
                    messageEmotion: nil,
                    stateVersion: nil
                ),
                StoredConversationMessageDTO(
                    id: "8B9CD590-9BF3-43C5-B8D4-A98685F8551E",
                    role: "assistant",
                    content: "覚えているよ",
                    observedAt: "2026-08-30T21:00:01.000Z",
                    messageEmotion: ShannonMessageEmotionDTO(
                        valence: 0.4,
                        arousal: 0.6,
                        openness: 0.5,
                        expression: .joyful
                    ),
                    stateVersion: 4,
                    sourceAttribution: ShannonSourceAttributionDTO(
                        title: "Hacker News",
                        url: "https://example.com/agents",
                        reason: "今日の関心と近いから。"
                    )
                ),
            ],
            state: TestFixtures.state(version: 5)
        )
        let client = HistoryClient(history: history)
        let model = ShannonConversationModel(client: client)

        await model.loadConversationIfNeeded()
        await model.loadConversationIfNeeded()

        XCTAssertEqual(model.messages.map(\.text), ["昨日の話", "覚えているよ"])
        XCTAssertEqual(model.messages.last?.emotionSnapshot?.expression, .joyful)
        XCTAssertEqual(model.messages.last?.sourceAttribution?.title, "Hacker News")
        XCTAssertEqual(model.messages.last?.sourceAttribution?.reason, "今日の関心と近いから。")
        XCTAssertEqual(model.currentExpression, .joyful)
        XCTAssertEqual(model.state?.version, 5)
        let loadCount = await client.loadCount
        XCTAssertEqual(loadCount, 1)
    }

    func testLoadsLatestThreadAndSwitchesWithoutMixingMessages() async {
        let client = ThreadClient()
        let model = ShannonConversationModel(client: client)

        await model.loadConversationIfNeeded()
        XCTAssertEqual(model.selectedThreadId, "thread-new")
        XCTAssertEqual(model.messages.map(\.text), ["新しいトークの会話"])

        await model.selectThread("thread-old")
        XCTAssertEqual(model.selectedThreadId, "thread-old")
        XCTAssertEqual(model.messages.map(\.text), ["古いトークの会話"])
        XCTAssertFalse(model.messages.contains(where: { $0.text == "新しいトークの会話" }))
    }

    func testRenamingThreadUpdatesTheListImmediatelyAfterSaving() async {
        let client = RenameThreadClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)

        await model.loadThreads(force: true)
        let didRename = await model.renameThread("thread-rename", title: "週末の計画")

        XCTAssertTrue(didRename)
        XCTAssertEqual(model.threads.first?.title, "週末の計画")
        XCTAssertNil(model.errorMessage)
        let captured = await client.capturedRename
        XCTAssertEqual(captured?.threadId, "thread-rename")
        XCTAssertEqual(captured?.title, "週末の計画")
    }

    func testExplicitlySendsOnlyAShannonReplyToAetherProposalInbox() async {
        let client = ProposalClient()
        let reply = ConversationMessage(role: .shannon, text: "設計案\nこの内容を残したい")
        let model = ShannonConversationModel(client: client, messages: [reply], usesDisplayCache: false)

        await model.sendToAether(reply)

        let captured = await client.captured
        XCTAssertEqual(captured?.title, "設計案")
        XCTAssertEqual(captured?.content, reply.text)
        XCTAssertEqual(model.statusMessage, "Aetherの提案箱へ送りました。")
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.aetherSubmittedMessageIDs.contains(reply.id))
        await model.sendToAether(reply)
        let callCount = await client.callCount
        XCTAssertEqual(callCount, 1)
    }

    func testInitiativeRefreshKeepsUnreadUntilTheTalkIsExplicitlyOpened() async {
        let client = InitiativeClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)

        await model.refreshInitiatives()

        XCTAssertEqual(model.selectedThreadId, "initiative-thread")
        XCTAssertEqual(model.messages.map(\.text), ["シャノンから届いた話"])
        XCTAssertEqual(model.unreadInitiativeCount, 1)
        XCTAssertEqual(model.initiativeThreadIDs, ["initiative-thread"])
        let refreshAcknowledgements = await client.markReadCount
        XCTAssertEqual(refreshAcknowledgements, 0)

        await model.acknowledgeVisibleInitiatives()

        XCTAssertEqual(model.unreadInitiativeCount, 0)
        XCTAssertTrue(model.initiativeThreadIDs.isEmpty)
        let explicitAcknowledgements = await client.markReadCount
        XCTAssertEqual(explicitAcknowledgements, 1)
        let acknowledgedThreads = await client.markReadThreadIDs
        XCTAssertEqual(acknowledgedThreads, ["initiative-thread"])
    }

    func testSelectingTheAlreadyVisibleInitiativeThreadAcknowledgesIt() async {
        let client = InitiativeClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        await model.refreshInitiatives()

        await model.selectThread("initiative-thread")

        XCTAssertEqual(model.unreadInitiativeCount, 0)
        let acknowledgements = await client.markReadCount
        XCTAssertEqual(acknowledgements, 1)
    }
}

private struct StubClient: ShannonAPIClientProtocol {
    let response: ChatResponseDTO
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO { response }
}

private actor TitleClient: ShannonAPIClientProtocol {
    private(set) var listLoads = 0
    private var pendingSend: CheckedContinuation<ChatResponseDTO, any Error>?
    private var sendWaiter: CheckedContinuation<Void, Never>?
    private var pendingList: CheckedContinuation<ThreadListResponseDTO, Never>?
    private var listWaiter: CheckedContinuation<Void, Never>?
    private var shouldDelayList = false

    private func thread(
        title: String = "新しいトーク",
        messageCount: Int = 0,
        summary: String? = nil,
        sections: [String]? = nil
    ) -> ChatThreadDTO {
        ChatThreadDTO(
            threadId: "test-thread", title: title, createdAt: "2026-09-05T00:00:00Z",
            updatedAt: "2026-09-05T00:00:01Z", messageCount: messageCount,
            summary: summary, sections: sections
        )
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        try await withCheckedThrowingContinuation { continuation in
            pendingSend = continuation
            sendWaiter?.resume()
            sendWaiter = nil
        }
    }

    func waitForSend() async {
        if pendingSend != nil { return }
        await withCheckedContinuation { sendWaiter = $0 }
    }

    func completeSend() {
        pendingSend?.resume(returning: TestFixtures.chatResponse(
            reply: "庭園を巡るのはどうかな。",
            thread: thread(
                title: "京都の庭園巡り",
                messageCount: 2,
                summary: "京都旅行を計画中。庭園を巡る案が出ている。",
                sections: ["候補", "次の確認"]
            )
        ))
        pendingSend = nil
    }

    func failSend() {
        pendingSend?.resume(throwing: TestFailure.offline)
        pendingSend = nil
    }

    func renameThread(scopeKey: String, threadId: String, title: String) async throws {}

    func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO {
        listLoads += 1
        if shouldDelayList {
            shouldDelayList = false
            return await withCheckedContinuation { continuation in
                pendingList = continuation
                listWaiter?.resume()
                listWaiter = nil
            }
        }
        return ThreadListResponseDTO(threads: [thread()])
    }

    func delayNextList() { shouldDelayList = true }

    func waitForList() async {
        if pendingList != nil { return }
        await withCheckedContinuation { listWaiter = $0 }
    }

    func completeList() {
        pendingList?.resume(returning: ThreadListResponseDTO(threads: [thread()]))
        pendingList = nil
    }
}

private enum TestFailure: Error {
    case offline
}

private actor SequenceClient: ShannonAPIClientProtocol {
    var results: [Result<ChatResponseDTO, TestFailure>]

    init(results: [Result<ChatResponseDTO, TestFailure>]) {
        self.results = results
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        try results.removeFirst().get()
    }
}

private actor HistoryClient: ShannonAPIClientProtocol {
    let history: ConversationHistoryResponseDTO
    private(set) var loadCount = 0

    init(history: ConversationHistoryResponseDTO) {
        self.history = history
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse()
    }

    func loadConversation(scopeKey: String, threadId: String?) async throws -> ConversationHistoryResponseDTO {
        loadCount += 1
        return history
    }
}

private actor ProposalClient: ShannonAPIClientProtocol {
    struct Captured: Sendable {
        let title: String
        let content: String
        let reason: String
    }
    private(set) var captured: Captured?
    private(set) var callCount = 0

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse()
    }

    func createAetherProposal(scopeKey: String, title: String, content: String, reason: String) async throws -> AetherProposalResponseDTO {
        callCount += 1
        captured = Captured(title: title, content: content, reason: reason)
        return AetherProposalResponseDTO(
            id: "proposal-1", operation: "new-note", title: title, content: content,
            reason: reason, createdAt: "2026-09-03T00:00:00.000Z"
        )
    }
}

private actor ThreadClient: ShannonAPIClientProtocol {
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse()
    }

    func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO {
        ThreadListResponseDTO(threads: [
            ChatThreadDTO(
                threadId: "thread-new", title: "新しい", createdAt: "2026-09-02T00:00:00Z",
                updatedAt: "2026-09-02T00:00:00Z", messageCount: 1
            ),
            ChatThreadDTO(
                threadId: "thread-old", title: "古い", createdAt: "2026-09-01T00:00:00Z",
                updatedAt: "2026-09-01T00:00:00Z", messageCount: 1
            ),
        ])
    }

    func loadConversation(scopeKey: String, threadId: String?) async throws -> ConversationHistoryResponseDTO {
        let resolved = threadId ?? "thread-new"
        let text = resolved == "thread-old" ? "古いトークの会話" : "新しいトークの会話"
        return ConversationHistoryResponseDTO(
            threadId: resolved,
            messages: [StoredConversationMessageDTO(
                id: UUID().uuidString,
                role: "user",
                content: text,
                observedAt: "2026-09-02T00:00:00.000Z",
                messageEmotion: nil,
                stateVersion: nil
            )],
            state: TestFixtures.state(version: 1)
        )
    }
}

private actor RenameThreadClient: ShannonAPIClientProtocol {
    struct CapturedRename: Sendable {
        let threadId: String
        let title: String
    }

    private(set) var capturedRename: CapturedRename?

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse()
    }

    func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO {
        ThreadListResponseDTO(threads: [
            ChatThreadDTO(
                threadId: "thread-rename", title: "最初のタイトル", createdAt: "2026-09-01T00:00:00Z",
                updatedAt: "2026-09-02T00:00:00Z", messageCount: 2
            )
        ])
    }

    func renameThread(scopeKey: String, threadId: String, title: String) async throws {
        capturedRename = CapturedRename(threadId: threadId, title: title)
    }
}

private actor InitiativeClient: ShannonAPIClientProtocol {
    private(set) var markReadCount = 0
    private(set) var markReadThreadIDs: [String?] = []

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse()
    }

    func loadInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO {
        ShannonInitiativeInboxDTO(
            unreadCount: 1,
            messages: [
                ShannonInitiativeMessageDTO(
                    id: "initiative-1",
                    threadId: "initiative-thread",
                    content: "シャノンから届いた話",
                    expression: .curious,
                    sourceTitle: "今日の関心",
                    sourceURL: "https://example.com/story",
                    createdAt: "2026-09-04T00:00:00.000Z",
                    readAt: nil
                )
            ]
        )
    }

    func markInitiativesRead(scopeKey: String, threadId: String?) async throws -> Int {
        markReadCount += 1
        markReadThreadIDs.append(threadId)
        return 1
    }

    func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO {
        ThreadListResponseDTO(threads: [
            ChatThreadDTO(
                threadId: "initiative-thread",
                title: "今日の関心",
                createdAt: "2026-09-04T00:00:00.000Z",
                updatedAt: "2026-09-04T00:00:00.000Z",
                messageCount: 1
            )
        ])
    }

    func loadConversation(scopeKey: String, threadId: String?) async throws -> ConversationHistoryResponseDTO {
        ConversationHistoryResponseDTO(
            threadId: threadId ?? "initiative-thread",
            messages: [
                StoredConversationMessageDTO(
                    id: "EA8BCB13-67D9-48B1-A338-512977DAD462",
                    role: "assistant",
                    content: "シャノンから届いた話",
                    observedAt: "2026-09-04T00:00:00.000Z",
                    messageEmotion: ShannonMessageEmotionDTO(
                        valence: 0.35,
                        arousal: 0.5,
                        openness: 0.7,
                        expression: .curious
                    ),
                    stateVersion: 1
                )
            ],
            state: TestFixtures.state(version: 1)
        )
    }
}

private actor AttachmentClient: ShannonAPIClientProtocol {
    struct Captured: Sendable {
        let message: String
        let attachments: [ShannonChatAttachmentDTO]
        let webSearch: Bool
    }

    private(set) var captured: Captured?

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse()
    }

    func send(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO]
    ) async throws -> ChatResponseDTO {
        captured = Captured(message: message, attachments: attachments, webSearch: false)
        return TestFixtures.chatResponse(reply: "資料を確認したよ")
    }

    func send(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool
    ) async throws -> ChatResponseDTO {
        captured = Captured(message: message, attachments: attachments, webSearch: webSearch)
        return TestFixtures.chatResponse(reply: "資料を確認したよ")
    }
}

private actor OrganizeClient: ShannonAPIClientProtocol {
    private(set) var applyCount = 0
    private var session = TestFixtures.organizeSession()

    func currentApplyCount() -> Int { applyCount }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse(
            reply: "Task案を確認してね",
            uiBlocks: [ShannonUIBlockDTO(type: "organize_session", session: session)]
        )
    }

    func decideOrganizeItem(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?
    ) async throws -> ShannonOrganizeSessionDTO {
        try await decideOrganizeItemV2(
            scopeKey: scopeKey, sessionId: sessionId, itemId: itemId,
            expectedRevision: expectedRevision, decision: decision,
            title: title, details: details, operation: nil, target: nil, projectIds: nil
        )
    }

    func decideOrganizeItemV2(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?,
        operation: ShannonOrganizeOperationDTO?,
        target: ShannonVoyagerTaskProjectionDTO?,
        projectIds: [String]?
    ) async throws -> ShannonOrganizeSessionDTO {
        let item = session.items[0]
        session = TestFixtures.organizeSession(
            state: .readyForReview,
            revision: expectedRevision + 1,
            item: ShannonOrganizeItemDTO(
                id: item.id,
                title: title ?? item.title,
                details: details ?? item.details,
                operation: operation,
                target: target,
                projectIds: projectIds,
                decision: decision,
                destinationStatus: .pending,
                requestId: item.requestId,
                idempotencyKey: item.idempotencyKey,
                result: nil,
                errorCode: nil
            )
        )
        return session
    }

    func searchVoyagerTasks(scopeKey: String, query: String) async throws -> [ShannonVoyagerTaskProjectionDTO] {
        [ShannonVoyagerTaskProjectionDTO(
            id: "task-existing", title: "既存Task", details: "現在の詳細", status: "pending",
            projectIds: [], revision: 4, updatedAt: "2026-09-09T00:00:00.000Z"
        )]
    }

    func loadVoyagerProjects(scopeKey: String) async throws -> [ShannonVoyagerProjectProjectionDTO] {
        [ShannonVoyagerProjectProjectionDTO(
            id: "project-shannon", title: "Shannon", revision: 2, updatedAt: "2026-09-09T00:00:00.000Z"
        )]
    }

    func applyOrganizeSession(scopeKey: String, sessionId: String, expectedRevision: Int) async throws -> ShannonOrganizeApplyResponseDTO {
        applyCount += 1
        let item = session.items[0]
        let reference = ShannonVoyagerTaskReferenceDTO(
            system: "voyager", resourceType: "task", resourceId: "00000000-0000-4000-8000-000000000003",
            title: item.title, summary: item.details, updatedAt: "2026-09-08T00:00:10.000Z", href: nil
        )
        session = TestFixtures.organizeSession(
            state: .applied,
            revision: expectedRevision + 1,
            item: ShannonOrganizeItemDTO(
                id: item.id, title: item.title, details: item.details,
                operation: item.operation, target: item.target, projectIds: item.projectIds,
                decision: .accepted,
                destinationStatus: .applied, requestId: item.requestId, idempotencyKey: item.idempotencyKey,
                result: reference, errorCode: nil
            )
        )
        return ShannonOrganizeApplyResponseDTO(session: session, appliedCount: 1, tasks: [reference])
    }
}

private enum TestFixtures {
    static func chatResponse(
        version: Int = 0,
        reply: String = "ok",
        expression: ShannonExpressionDTO = .calm,
        thread: ChatThreadDTO? = nil,
        artifacts: [ShannonGeneratedArtifactDTO]? = nil,
        uiBlocks: [ShannonUIBlockDTO]? = nil
    ) -> ChatResponseDTO {
        ChatResponseDTO(
            mode: "local-stub",
            reply: reply,
            threadId: "test-thread",
            snapshotVersion: version,
            messageEmotion: ShannonMessageEmotionDTO(
                valence: 0,
                arousal: 0.3,
                openness: 0.35,
                expression: expression
            ),
            systemPrompt: "prompt",
            state: state(version: version),
            uiBlocks: uiBlocks,
            artifacts: artifacts,
            thread: thread
        )
    }

    static let organizeSessionID = "00000000-0000-4000-8000-000000000010"
    static let organizeItemID = "00000000-0000-4000-8000-000000000011"
    static let organizeMessageID = "00000000-0000-4000-8000-000000000012"

    static func organizeSession(
        state: ShannonOrganizeSessionStateDTO = .readyForReview,
        revision: Int = 1,
        item: ShannonOrganizeItemDTO? = nil
    ) -> ShannonOrganizeSessionDTO {
        ShannonOrganizeSessionDTO(
            id: organizeSessionID,
            scopeKey: "local-owner",
            threadId: "test-thread",
            state: state,
            revision: revision,
            sourceMessageIds: ["00000000-0000-4000-8000-000000000013"],
            commandThroughMessageId: organizeMessageID,
            items: [item ?? ShannonOrganizeItemDTO(
                id: organizeItemID,
                title: "Task案",
                details: "短い実行内容",
                decision: .proposed,
                destinationStatus: .pending,
                requestId: "00000000-0000-4000-8000-000000000014",
                idempotencyKey: "00000000-0000-4000-8000-000000000015",
                result: nil,
                errorCode: nil
            )],
            createdAt: "2026-09-08T00:00:00.000Z",
            updatedAt: "2026-09-08T00:00:00.000Z",
            appliedAt: state == .applied ? "2026-09-08T00:00:10.000Z" : nil
        )
    }

    static func state(version: Int) -> CompanionStateDTO {
        CompanionStateDTO(
            scopeKey: "local-owner",
            version: version,
            updatedAt: "2026-08-31T00:00:00.000Z",
            temperament: ShannonTemperamentDTO(
                curiosity: 0.65,
                initiative: 0.25,
                closeness: 0.15,
                calmness: 0.60,
                needForContinuity: 0.70,
                confidenceAboutUser: 0.05
            ),
            emotion: ShannonEmotionDTO(valence: 0, arousal: 0.3, openness: 0.35),
            interests: [],
            userFacts: [],
            activeMemories: []
        )
    }
}
