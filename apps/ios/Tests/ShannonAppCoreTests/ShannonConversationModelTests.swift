import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonConversationModelTests: XCTestCase {
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
        let listLoads = await client.listLoads
        XCTAssertEqual(listLoads, 1, "The title must not wait for another thread-list request")
        XCTAssertFalse(model.isSending)

        let restored = ShannonConversationModel(scopeKey: scopeKey, client: client, usesDisplayCache: true)
        XCTAssertEqual(restored.selectedThread?.title, "京都の庭園巡り")
        XCTAssertEqual(restored.messages.map(\.text), model.messages.map(\.text))
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
                    stateVersion: 4
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

    private func thread(title: String = "新しいトーク", messageCount: Int = 0) -> ChatThreadDTO {
        ChatThreadDTO(
            threadId: "test-thread", title: title, createdAt: "2026-09-05T00:00:00Z",
            updatedAt: "2026-09-05T00:00:01Z", messageCount: messageCount
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
            reply: "庭園を巡るのはどうかな。", thread: thread(title: "京都の庭園巡り", messageCount: 2)
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

    func markInitiativesRead(scopeKey: String) async throws -> Int {
        markReadCount += 1
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

private enum TestFixtures {
    static func chatResponse(
        version: Int = 0,
        reply: String = "ok",
        expression: ShannonExpressionDTO = .calm,
        thread: ChatThreadDTO? = nil
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
            thread: thread
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
