import ShannonAppCore
import Testing
import XCTest

final class ShannonDesktopWorkProjectionTests: XCTestCase {
    func testThreadSearchMatchesCaseDiacriticsAndFullWidthText() {
        let threads = [
            makeThread(id: "clear", title: "Clear Signal の配色"),
            makeThread(id: "cafe", title: "Caféでのメモ"),
            makeThread(id: "other", title: "長期計画"),
        ]

        XCTAssertEqual(
            ShannonDesktopThreadSearch.matches(threads, query: "ＣＬＥＡＲ").map(\.threadId),
            ["clear"]
        )
        XCTAssertEqual(
            ShannonDesktopThreadSearch.matches(threads, query: "cafe").map(\.threadId),
            ["cafe"]
        )
    }

    func testThreadSearchPreservesServerOrderAndReturnsFirstResult() {
        let threads = [
            makeThread(id: "new", title: "Mac版 UI"),
            makeThread(id: "old", title: "Mac版 設計"),
        ]

        XCTAssertEqual(
            ShannonDesktopThreadSearch.firstResultID(in: threads, query: "Mac版"),
            "new"
        )
        XCTAssertEqual(
            ShannonDesktopThreadSearch.matches(threads, query: "  ").map(\.threadId),
            ["new", "old"]
        )
    }

    func testThreadSearchIncludesServerSummaryAndSections() {
        let threads = [
            makeThread(
                id: "context",
                title: "日々の相談",
                summary: "Mac版の現在地を整理しました",
                sections: ["次にやること", "検証結果"]
            ),
            makeThread(id: "other", title: "買い物")
        ]

        XCTAssertEqual(ShannonDesktopThreadSearch.matches(threads, query: "現在地").map(\.threadId), ["context"])
        XCTAssertEqual(ShannonDesktopThreadSearch.matches(threads, query: "検証結果").map(\.threadId), ["context"])
        XCTAssertEqual(
            ShannonDesktopThreadSearch.matchContext(for: threads[0], query: "次にやること"),
            "次にやること"
        )
    }

    func testThreadProjectionSeparatesUnreadInitiativesWithoutChangingSearchOrder() {
        let threads = [
            makeThread(id: "recent", title: "最近の会話"),
            makeThread(id: "initiative", title: "シャノンからの提案", summary: "新しい発見があります"),
            makeThread(id: "older", title: "以前の会話"),
        ]

        let normal = ShannonDesktopThreadProjection(
            threads: threads,
            initiativeThreadIDs: ["initiative"],
            query: ""
        )
        XCTAssertEqual(normal.initiative.map(\.threadId), ["initiative"])
        XCTAssertEqual(normal.conversations.map(\.threadId), ["recent", "older"])
        XCTAssertEqual(normal.allVisible.map(\.threadId), ["initiative", "recent", "older"])

        let search = ShannonDesktopThreadProjection(
            threads: threads,
            initiativeThreadIDs: ["initiative"],
            query: "新しい"
        )
        XCTAssertTrue(search.isSearching)
        XCTAssertTrue(search.initiative.isEmpty)
        XCTAssertEqual(search.conversations.map(\.threadId), ["initiative"])
    }

    func testAttachmentLoaderReadsSupportedUTF8TextAndKeepsItsMetadata() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("notes.md")
        try Data("# 設計メモ\n本文".utf8).write(to: url)

        let loaded = try ShannonDesktopAttachmentLoader.load(urls: [url])

        XCTAssertEqual(loaded, [
            ShannonChatAttachmentDTO(name: "notes.md", mimeType: "text/markdown", text: "# 設計メモ\n本文")
        ])
    }

    func testAttachmentLoaderRejectsUnsupportedAndOversizedFiles() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let binary = folder.appendingPathComponent("sample.png")
        try Data([0, 1, 2]).write(to: binary)
        let large = folder.appendingPathComponent("large.txt")
        try Data(repeating: 65, count: ShannonDesktopAttachmentLimits.maximumBytesPerFile + 1).write(to: large)

        XCTAssertThrowsError(try ShannonDesktopAttachmentLoader.load(urls: [binary])) { error in
            XCTAssertEqual(error as? ShannonDesktopAttachmentError, .unsupportedType("sample.png"))
        }
        XCTAssertThrowsError(try ShannonDesktopAttachmentLoader.load(urls: [large])) { error in
            XCTAssertEqual(error as? ShannonDesktopAttachmentError, .fileTooLarge("large.txt"))
        }
    }

    @MainActor
    func testDesignPreviewThreadSwitchStaysOfflineAndClear() async {
        let model = ShannonConversationModel.designPreview()

        await model.selectThread("roadmap-preview")
        XCTAssertEqual(model.selectedThreadId, "roadmap-preview")
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.errorMessage)

        await model.selectThread("design-preview")
        XCTAssertEqual(model.messages.count, 6)
        XCTAssertNil(model.errorMessage)
    }

    func testProjectionSeparatesCurrentProposedAndFinishedWork() {
        let now = Date()
        let active = makeTask(status: .running, updatedAt: now)
        let proposed = makeTask(status: .proposed, updatedAt: now.addingTimeInterval(-10))
        let completed = makeTask(status: .completed, updatedAt: now.addingTimeInterval(-20))

        let projection = ShannonDesktopWorkProjection(tasks: [completed, proposed, active])

        XCTAssertEqual(projection.active.map(\.id), [active.id])
        XCTAssertEqual(projection.proposed.map(\.id), [proposed.id])
        XCTAssertEqual(projection.finished.map(\.id), [completed.id])
    }

    func testTaskRestorationKeepsKnownSelectionAndFallsBackByWorkPriority() {
        let active = makeTask(status: .running)
        let proposed = makeTask(status: .proposed)
        let completed = makeTask(status: .completed)
        let tasks = [completed, proposed, active]

        XCTAssertEqual(
            ShannonDesktopTaskRestoration.resolve(rawValue: completed.id.uuidString, tasks: tasks),
            completed.id
        )
        XCTAssertEqual(
            ShannonDesktopTaskRestoration.resolve(rawValue: UUID().uuidString, tasks: tasks),
            active.id
        )
        XCTAssertEqual(
            ShannonDesktopTaskRestoration.resolve(rawValue: "not-a-uuid", tasks: [completed, proposed]),
            proposed.id
        )
        XCTAssertNil(ShannonDesktopTaskRestoration.resolve(rawValue: nil, tasks: []))
    }

    func testWindowRestorationUsesSceneStateBeforeLastWindowFallback() {
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.destination(sceneRawValue: "work", lastRawValue: "memory"),
            .work
        )
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.destination(sceneRawValue: nil, lastRawValue: "memory"),
            .shannon
        )
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.destination(sceneRawValue: "shannon", lastRawValue: "talk"),
            .shannon
        )
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.destination(sceneRawValue: "unknown", lastRawValue: "unknown"),
            .talk
        )
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.destination(sceneRawValue: "development", lastRawValue: "talk"),
            .development
        )

        XCTAssertEqual(
            ShannonDesktopWindowRestoration.identifier(sceneValue: "scene-thread", lastValue: "last-thread"),
            "scene-thread"
        )
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.identifier(sceneValue: nil, lastValue: "last-thread"),
            "last-thread"
        )
        XCTAssertNil(ShannonDesktopWindowRestoration.identifier(sceneValue: nil, lastValue: ""))

        XCTAssertTrue(ShannonDesktopWindowRestoration.inspectorVisible(sceneRawValue: "visible", lastValue: false))
        XCTAssertFalse(ShannonDesktopWindowRestoration.inspectorVisible(sceneRawValue: "hidden", lastValue: true))
        XCTAssertTrue(ShannonDesktopWindowRestoration.inspectorVisible(sceneRawValue: nil, lastValue: true))

        XCTAssertEqual(
            ShannonDesktopWindowRestoration.auxiliaryPanel(sceneRawValue: "outline", lastRawValue: "task"),
            .outline
        )
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.auxiliaryPanel(sceneRawValue: nil, lastRawValue: "outline"),
            .outline
        )
        XCTAssertEqual(
            ShannonDesktopWindowRestoration.auxiliaryPanel(sceneRawValue: "unknown", lastRawValue: "unknown"),
            .task
        )

        let initialChrome = ShannonDesktopWindowRestoration.windowChrome(
            sceneInspectorRawValue: nil,
            sceneAuxiliaryPanelRawValue: nil,
            lastInspectorVisible: true,
            lastAuxiliaryPanelRawValue: "outline"
        )
        let restoredChrome = ShannonDesktopWindowRestoration.windowChrome(
            sceneInspectorRawValue: "visible",
            sceneAuxiliaryPanelRawValue: "outline",
            lastInspectorVisible: false,
            lastAuxiliaryPanelRawValue: "task"
        )
        XCTAssertEqual(initialChrome, restoredChrome)
        XCTAssertTrue(initialChrome.showsInspector)
        XCTAssertEqual(initialChrome.auxiliaryPanel, .outline)
    }

    func testFourPillarsHoldDevelopmentAndReleaseInsideWork() {
        XCTAssertEqual(DesktopPillar.allCases, [.talk, .work, .shannon, .settings])
        XCTAssertEqual(DesktopDestination.development.pillar, .work)
        XCTAssertEqual(DesktopDestination.release.pillar, .work)
        XCTAssertEqual(DesktopDestination.shannon.pillar, .shannon)
        XCTAssertEqual(DesktopWorkPage(destination: .release), .release)
        XCTAssertNil(DesktopWorkPage(destination: .settings))
        XCTAssertEqual(DesktopWorkPage.allCases.map(\.destination), [.work, .development, .release])
        XCTAssertEqual(DesktopShannonPage.restoring(nil), .now)
        XCTAssertEqual(DesktopShannonPage.restoring("study"), .study)
        XCTAssertEqual(DesktopShannonPage.restoring("unknown"), .now)
    }

    func testNotificationsFollowTheIPhonePushRules() throws {
        let approval = ShannonAgentApproval(externalRequestID: "req-1", kind: .network, title: "外部接続の許可", reason: "取得")
        let waiting = ShannonAgentTask(
            conversationThreadID: "t1", title: "資料を集める", goal: "g", status: .waitingApproval,
            summary: "s", pendingApproval: approval
        )
        let done = ShannonAgentTask(conversationThreadID: "t1", title: "要約", goal: "g", status: .completed, summary: "s")
        let cancelled = ShannonAgentTask(conversationThreadID: "t1", title: "やめた", goal: "g", status: .cancelled, summary: "s")
        let seen = ShannonAgentTask(conversationThreadID: "t1", title: "見た", goal: "g", status: .failed, summary: "s")
        let room = try JSONDecoder().decode(ShannonInitiativeMessageDTO.self, from: Data("""
        {"id":"i1","threadId":"t2","content":"机の上にマグカップ","expression":"curious","sourceTitle":"部屋を見た",
         "sourceURL":"","createdAt":"2026-10-05T00:00:00Z","readAt":null,"roomLook":true}
        """.utf8))
        let plain = try JSONDecoder().decode(ShannonInitiativeMessageDTO.self, from: Data("""
        {"id":"i2","threadId":"t3","content":"面白い記事がありました","expression":"excited","sourceTitle":"HN",
         "sourceURL":"","createdAt":"2026-10-05T00:00:00Z","readAt":null}
        """.utf8))

        let notices = DesktopNotificationPlan.notices(
            tasks: [waiting, done, cancelled, seen],
            needsNotice: { $0.id != seen.id },
            initiatives: [room, plain]
        )
        XCTAssertEqual(notices.map(\.title), ["シャノン · 許可待ち", "シャノン · 完了", "シャノン", "シャノン"])
        XCTAssertEqual(notices[0].body, "「資料を集める」を続けるには、外部接続の許可が必要です。")
        XCTAssertEqual(notices[0].target, .task(waiting.id))
        XCTAssertEqual(notices[1].body, "ライ氏、「要約」の作業が終わりました。")
        XCTAssertEqual(notices[2].body, "ライ氏、部屋のことでひとことあります。")
        XCTAssertEqual(notices[3].body, "面白い記事がありました")
        XCTAssertEqual(notices[3].target, .thread("t3"))

        let first = DesktopNotificationPlan.toPost(notices, delivered: nil)
        XCTAssertTrue(first.post.isEmpty)
        XCTAssertEqual(first.delivered.count, 4)
        XCTAssertTrue(DesktopNotificationPlan.toPost(notices, delivered: first.delivered).post.isEmpty)
        let later = DesktopNotificationPlan.toPost(notices, delivered: Array(first.delivered.dropFirst()))
        XCTAssertEqual(later.post.map(\.key), [notices[0].key])
    }

    func testSettingsOpenWithAdminFirstAndFallBackWithoutOps() {
        XCTAssertEqual(DesktopSettingsPage.admin, [.ops, .devices, .delivery, .diagnostics])
        XCTAssertEqual(DesktopSettingsPage.admin + DesktopSettingsPage.others, DesktopSettingsPage.allCases)
        XCTAssertEqual(DesktopSettingsPage.restoring(nil, opsSupported: true), .ops)
        XCTAssertEqual(DesktopSettingsPage.restoring(nil, opsSupported: false), .devices)
        XCTAssertEqual(DesktopSettingsPage.restoring("ops", opsSupported: false), .devices)
        XCTAssertEqual(DesktopSettingsPage.restoring("calendar", opsSupported: false), .calendar)
        XCTAssertEqual(DesktopSettingsPage.restoring("unknown", opsSupported: true), .ops)
    }

    func testDevelopmentOptionsDiscardUnsupportedModelAndNormalizeReasoning() {
        let model = ShannonAgentModelDTO(
            id: "codex-main",
            displayName: "Codex Main",
            description: nil,
            supportedReasoningEfforts: [.medium, .high],
            defaultReasoningEffort: .high
        )

        XCTAssertEqual(
            ShannonDesktopDevelopmentOptions.normalizedModelID("retired-model", models: [model]),
            ""
        )
        XCTAssertEqual(
            ShannonDesktopDevelopmentOptions.normalizedModelID("codex-main", models: [model]),
            "codex-main"
        )
        XCTAssertEqual(
            ShannonDesktopDevelopmentOptions.normalizedReasoningEffort(
                .ultra,
                modelID: "codex-main",
                models: [model]
            ),
            .high
        )
    }

    func testDevelopmentFileTreeBuildsStableNestedPaths() {
        let roots = DevelopmentFileNode.roots(paths: [
            "apps/ios/App.swift",
            "apps/macos/App.swift",
            "README.md",
        ])

        XCTAssertEqual(roots.map(\.path), ["README.md", "apps"])
        XCTAssertEqual(roots[1].children?.map(\.path), ["apps/ios", "apps/macos"])
        XCTAssertEqual(roots[1].children?.first?.children?.map(\.path), ["apps/ios/App.swift"])
    }

    func testNextActionPrefersApprovalThenPendingPlanItem() {
        let approval = makeTask(status: .waitingApproval)
        let running = makeTask(
            status: .running,
            plan: [.init(id: "verify", title: "テストして結果をまとめる", status: .pending)]
        )

        XCTAssertEqual(
            ShannonDesktopWorkProjection.nextAction(for: approval),
            "あなたが許可するかを決める"
        )
        XCTAssertEqual(
            ShannonDesktopWorkProjection.nextAction(for: running),
            "テストして結果をまとめる"
        )
    }

    func testStoppedWorkShowsTheHostNextActionAndCountsAsWaitingForTheOwner() {
        var stopped = makeTask(
            status: .paused,
            plan: [.init(id: "verify", title: "テストして結果をまとめる", status: .pending)]
        )
        stopped.pauseReason = .needsOwner
        stopped.currentAction = "実機で起動を確認"
        var ownerPaused = makeTask(status: .paused)
        ownerPaused.pauseReason = .owner

        XCTAssertEqual(ShannonDesktopWorkProjection.nextAction(for: stopped), "実機で起動を確認")
        XCTAssertEqual(stopped.stateName, "続きが必要")
        XCTAssertEqual(ownerPaused.stateName, "一時停止中")
        let attention = ShannonDesktopWorkProjection(tasks: [stopped, ownerPaused], filter: .attention)
        XCTAssertEqual(attention.active.map(\.id), [stopped.id])
        XCTAssertEqual(ShannonDesktopTaskFilter.attention.title, "対応待ち")
    }

    func testTaskConversationContextPreservesSourceAndResolvesThreadTitle() {
        let sourceMessageID = UUID()
        let task = makeTask(
            status: .running,
            conversationThreadID: "thread-work",
            sourceMessageID: sourceMessageID
        )
        let context = ShannonDesktopConversationContext(task: task)

        XCTAssertEqual(context.threadID, "thread-work")
        XCTAssertEqual(context.sourceMessageID, sourceMessageID)
        XCTAssertEqual(
            context.title(in: [makeThread(id: "thread-work", title: "Mac版を仕上げる")]),
            "Mac版を仕上げる"
        )
        XCTAssertEqual(context.title(in: []), "この作業を始めたトーク")
    }

    func testTaskActionPolicyFollowsDurableStatus() {
        let proposed = ShannonDesktopTaskActionPolicy(status: .proposed)
        XCTAssertTrue(proposed.canStart)
        XCTAssertFalse(proposed.canSteer)
        XCTAssertTrue(proposed.canCancel)

        let running = ShannonDesktopTaskActionPolicy(status: .running)
        XCTAssertTrue(running.canPause)
        XCTAssertTrue(running.canSteer)
        XCTAssertTrue(running.canCancel)

        let paused = ShannonDesktopTaskActionPolicy(status: .paused)
        XCTAssertTrue(paused.canResume)
        XCTAssertTrue(paused.canSteer)

        let completed = ShannonDesktopTaskActionPolicy(status: .completed)
        XCTAssertFalse(completed.canStart)
        XCTAssertFalse(completed.canPause)
        XCTAssertFalse(completed.canResume)
        XCTAssertFalse(completed.canSteer)
        XCTAssertFalse(completed.canCancel)
    }

    func testConversationOutlineIncludesRequestsAndMarkdownHeadings() {
        let requestID = UUID()
        let answerID = UUID()
        let messages = [
            ConversationMessage(
                id: requestID,
                role: .user,
                text: "  Mac版の作業全体を もっと分かりやすくして  "
            ),
            ConversationMessage(
                id: answerID,
                role: .shannon,
                text: "# 現在地\n本文\n## 次にやること\n```\n# コード内は除外\n```"
            ),
        ]

        let entries = ShannonDesktopConversationOutline.entries(from: messages)

        XCTAssertEqual(entries.map(\.messageID), [requestID, answerID, answerID])
        XCTAssertEqual(entries.map(\.title), [
            "Mac版の作業全体を もっと分かりやすくして",
            "現在地",
            "次にやること",
        ])
        XCTAssertEqual(entries.map(\.level), [0, 1, 2])
        XCTAssertEqual(entries.map(\.kind), [.request, .heading, .heading])
        XCTAssertEqual(entries.map(\.id), [
            ShannonDesktopConversationOutline.requestAnchorID(messageID: requestID),
            ShannonDesktopConversationOutline.headingAnchorID(messageID: answerID, blockIndex: 0),
            ShannonDesktopConversationOutline.headingAnchorID(messageID: answerID, blockIndex: 2),
        ])
    }

    func testConversationOutlineTracksNearestSectionAtReadingLine() {
        let firstID = UUID()
        let secondID = UUID()
        let messages = [
            ConversationMessage(id: firstID, role: .user, text: "最初の依頼"),
            ConversationMessage(id: secondID, role: .shannon, text: "# 方針\n本文\n## 検証\n結果"),
        ]
        let entries = ShannonDesktopConversationOutline.entries(from: messages)
        let positions: [String: CGFloat] = [
            entries[0].id: -180.0,
            entries[1].id: 54.0,
            entries[2].id: 260.0,
        ]

        XCTAssertEqual(
            ShannonDesktopConversationOutline.activeEntryID(
                entries: entries,
                verticalPositions: positions,
                activationLine: 92
            ),
            entries[1].id
        )
        XCTAssertEqual(
            ShannonDesktopConversationOutline.activeEntryID(
                entries: entries,
                verticalPositions: [entries[2].id: 140],
                activationLine: 92
            ),
            entries[2].id
        )
        XCTAssertNil(
            ShannonDesktopConversationOutline.activeEntryID(
                entries: entries,
                verticalPositions: [:],
                activationLine: 92
            )
        )
    }

    func testConversationSearchTargetPrefersSectionThenFallsBackToMessageBody() {
        let requestID = UUID()
        let firstAnswerID = UUID()
        let latestAnswerID = UUID()
        let messages = [
            ConversationMessage(id: requestID, role: .user, text: "配色を確認したい"),
            ConversationMessage(id: firstAnswerID, role: .shannon, text: "## 検証結果\n配色は正常です。"),
            ConversationMessage(id: latestAnswerID, role: .shannon, text: "次は横断検索を仕上げます。"),
        ]

        XCTAssertEqual(
            ShannonDesktopConversationOutline.searchTargetMessageID(in: messages, query: "検証結果"),
            firstAnswerID
        )
        XCTAssertEqual(
            ShannonDesktopConversationOutline.searchTargetMessageID(in: messages, query: "横断検索"),
            latestAnswerID
        )
        XCTAssertNil(ShannonDesktopConversationOutline.searchTargetMessageID(in: messages, query: ""))
    }

    func testRepositoryInputAcceptsOnlyBoundedGitHubCoordinates() {
        XCTAssertTrue(ShannonDesktopRepositoryInput(
            repositoryURL: "https://github.com/example/new-app.git",
            projectKey: "new-app"
        ).isValid)
        XCTAssertFalse(ShannonDesktopRepositoryInput(
            repositoryURL: "file:///tmp/new-app",
            projectKey: "new-app"
        ).isValid)
        XCTAssertFalse(ShannonDesktopRepositoryInput(
            repositoryURL: "https://github.com/example/new%2Fapp",
            projectKey: "new-app"
        ).isValid)
        XCTAssertFalse(ShannonDesktopRepositoryInput(
            repositoryURL: "https://github.com/example/new-app",
            projectKey: "../escape"
        ).isValid)
        XCTAssertEqual(
            ShannonDesktopRepositoryInput.suggestedKey(from: "https://github.com/example/New-App.git"),
            "new-app"
        )
    }

    private func makeTask(
        status: ShannonAgentTaskStatus,
        updatedAt: Date = Date(),
        plan: [ShannonAgentPlanItem] = [],
        conversationThreadID: String = "thread-test",
        sourceMessageID: UUID? = nil
    ) -> ShannonAgentTask {
        ShannonAgentTask(
            conversationThreadID: conversationThreadID,
            sourceMessageID: sourceMessageID,
            title: "Mac版を仕上げる",
            goal: "Macで会話と作業を継続できる",
            status: status,
            summary: "実装を進めています",
            plan: plan,
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
    }

    private func makeThread(
        id: String,
        title: String,
        summary: String? = nil,
        sections: [String]? = nil
    ) -> ChatThreadDTO {
        ChatThreadDTO(
            threadId: id,
            title: title,
            createdAt: "2026-09-08T00:00:00Z",
            updatedAt: "2026-09-08T00:00:00Z",
            messageCount: 1,
            summary: summary,
            sections: sections
        )
    }
}

@Suite("Mac development workspace")
struct ShannonDesktopDevelopmentWorkspaceTests {
    @Test(arguments: [719.0, 640.0, 480.0])
    func compactTaskLayoutFitsNarrowWidths(_ width: CGFloat) {
        #expect(!ShannonDesktopDevelopmentLayout.showsTaskNavigator(availableWidth: width))
    }

    @Test(arguments: [720.0, 900.0, 1_200.0])
    func taskNavigatorAppearsWhenWorkspaceCanSupportIt(_ width: CGFloat) {
        #expect(ShannonDesktopDevelopmentLayout.showsTaskNavigator(availableWidth: width))
    }

    @Test
    func reviewChangesKeepLatestEntryPerFile() throws {
        var task = ShannonAgentTaskFixtures.completed()
        task.changes = [
            .init(
                displayName: "Store.swift",
                path: "Sources/Store.swift",
                summary: "最初の変更",
                additions: 2,
                deletions: 0
            ),
            .init(
                displayName: "Store.swift",
                path: "Sources/Store.swift",
                summary: "検証後の変更",
                additions: 4,
                deletions: 1,
                diffPreview: "+let verified = true"
            ),
            .init(
                displayName: "StoreTests.swift",
                path: "Tests/StoreTests.swift",
                summary: "回帰試験",
                additions: 8,
                deletions: 0
            ),
        ]

        let changes = ShannonDesktopReviewChange.items(project: nil, task: task)

        #expect(changes.map(\.id) == ["Sources/Store.swift", "Tests/StoreTests.swift"])
        let store = try #require(changes.first)
        #expect(store.summary == "検証後の変更")
        #expect(store.additions == 4)
        #expect(store.deletions == 1)
    }

    @Test
    func largeDiffProjectionPreservesEveryLineWithStableIdentity() throws {
        let diff = (0..<12_000).map { index in
            index.isMultiple(of: 2) ? "+line \(index)" : "-line \(index)"
        }.joined(separator: "\n") + "\n"

        let lines = ShannonDesktopDiffProjection.lines(in: diff)

        #expect(lines.count == 12_001)
        #expect(lines.first == ShannonDesktopDiffLine(id: 0, text: "+line 0"))
        #expect(lines[11_999] == ShannonDesktopDiffLine(id: 11_999, text: "-line 11999"))
        #expect(lines.last == ShannonDesktopDiffLine(id: 12_000, text: ""))
    }
}
