import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonAgentTaskAttentionTests: XCTestCase {
    // MARK: Acknowledgement refers to the thing seen, not to the task

    func testTaskOpenedOnceStillRaisesItsLaterApprovalStopAndResult() {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let id = model.installAgentTaskFixture(status: .running)

        // Opening the room to start or watch running work acknowledges nothing that comes later.
        model.acknowledgeAgentTask(id)
        XCTAssertNil(model.latestAgentTaskNotice)

        model.upsertAgentTask(replacing(id, with: ShannonAgentTaskFixtures.waitingCommandApproval()))
        XCTAssertEqual(model.latestAgentTaskNotice?.id, id)
        XCTAssertEqual(model.unreadAgentTaskCount, 1)

        model.upsertAgentTask(replacing(id, with: ShannonAgentTaskFixtures.needsOwner()))
        XCTAssertEqual(model.latestAgentTaskNotice?.id, id)
        model.acknowledgeAgentTask(id)
        XCTAssertNil(model.latestAgentTaskNotice)
        XCTAssertEqual(model.unreadAgentTaskCount, 0)

        // The same task stopping again is a new stop the owner has not seen.
        var secondStop = replacing(id, with: ShannonAgentTaskFixtures.needsOwner())
        secondStop.pauseSequence = 9
        model.upsertAgentTask(secondStop)
        XCTAssertEqual(model.latestAgentTaskNotice?.id, id)
        model.acknowledgeAgentTask(id)

        model.upsertAgentTask(replacing(id, with: ShannonAgentTaskFixtures.completed()))
        XCTAssertEqual(model.latestAgentTaskNotice?.id, id)
        XCTAssertEqual(model.totalBadgeCount, 1)
        model.acknowledgeAgentTask(id)
        XCTAssertNil(model.latestAgentTaskNotice)
        XCTAssertEqual(model.totalBadgeCount, 0)
    }

    func testOpeningTheRoomDoesNotClearAPendingApprovalUntilItIsDecided() async {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let id = model.installAgentTaskFixture(status: .waitingApproval)

        model.acknowledgeAgentTask(id)
        XCTAssertEqual(model.latestAgentTaskNotice?.id, id)
        XCTAssertEqual(model.unreadAgentTaskCount, 1)

        await model.resolveAgentApproval(id, accepted: true)
        XCTAssertNil(model.latestAgentTaskNotice)
        XCTAssertEqual(model.unreadAgentTaskCount, 0)
    }

    func testANewApprovalOnTheSameTaskIsANewNotice() {
        var first = ShannonAgentTaskFixtures.waitingCommandApproval()
        let firstKey = first.attention?.key
        first.pendingApproval = ShannonAgentApproval(
            externalRequestID: "second-request", kind: .command, title: "コマンド実行の許可", reason: "必要"
        )
        XCTAssertNotEqual(first.attention?.key, firstKey)
    }

    func testOwnerPauseIsNotAttentionButAHostStopIs() {
        var task = ShannonAgentTaskFixtures.running()
        task.status = .paused
        task.pauseReason = .owner
        task.currentAction = nil
        XCTAssertNil(task.attention)
        XCTAssertEqual(task.stateName, "一時停止中")
        XCTAssertEqual(task.stageDescription, "あなたが一時停止した作業です")

        let stopped = ShannonAgentTaskFixtures.needsOwner()
        XCTAssertEqual(stopped.attention, .nextAction("4"))
        XCTAssertEqual(stopped.stateName, "続きが必要")
        XCTAssertEqual(stopped.nextAction, "iPhoneで再起動後にログインできるか確認して、結果を伝える")

        // A server that predates the field: a next action marks the stop as the owner's turn.
        var legacy = stopped
        legacy.pauseReason = nil
        legacy.pauseSequence = nil
        XCTAssertTrue(legacy.needsOwnerToContinue)
        legacy.currentAction = nil
        XCTAssertFalse(legacy.needsOwnerToContinue)
    }

    func testApprovalOutranksAStopAndAResultInTheSingleNotice() {
        let model = ShannonConversationModel(usesDisplayCache: false)
        var completed = ShannonAgentTaskFixtures.completed(now: Date())
        completed.title = "完了した作業"
        let stopped = ShannonAgentTaskFixtures.needsOwner(now: Date().addingTimeInterval(-60))
        let approval = ShannonAgentTaskFixtures.waitingCommandApproval(now: Date().addingTimeInterval(-600))
        [completed, stopped, approval].forEach(model.upsertAgentTask)

        XCTAssertEqual(model.latestAgentTaskNotice?.id, approval.id)
        XCTAssertEqual(model.unreadAgentTaskCount, 3)
    }

    func testCancellingHereDoesNotNotifyTheOwnerOfTheirOwnDecision() async {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let id = model.installAgentTaskFixture(status: .proposed)
        await model.cancelAgentTask(id)
        XCTAssertEqual(model.agentTask(id: id)?.status, .cancelled)
        XCTAssertNil(model.latestAgentTaskNotice)
    }

    // MARK: Stored acknowledgements

    func testLegacyAcknowledgementsDoNotResurrectOldFinishedWorkButLaterStatesNotify() throws {
        let suiteName = "ShannonAgentTaskAttentionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ShannonAgentTaskStore(defaults: defaults)
        let migratedAt = Date()
        let finished = ShannonAgentTaskFixtures.completed(now: migratedAt.addingTimeInterval(-3_600))
        let running = ShannonAgentTaskFixtures.running(now: migratedAt.addingTimeInterval(-3_600))
        var uncached = ShannonAgentTaskFixtures.completed(now: migratedAt.addingTimeInterval(-7_200))
        uncached.title = "この端末のキャッシュに無かった古い完了"
        defaults.set(
            [finished, running, uncached].map(\.id.uuidString),
            forKey: "shannon.agent-task-acknowledgements.v1.owner-a"
        )

        let acknowledgements = store.loadAcknowledgements(
            scopeKey: "owner-a", tasks: [finished, running], now: migratedAt
        )

        XCTAssertFalse(acknowledgements.needsNotice(finished))
        XCTAssertFalse(acknowledgements.needsNotice(uncached), "an old finished task must stay quiet")
        // Pinning bumps `updatedAt`; a task that was finished when it was acknowledged stays quiet.
        var pinned = finished
        pinned.updatedAt = migratedAt.addingTimeInterval(60)
        XCTAssertFalse(acknowledgements.needsNotice(pinned))

        // The task that was only opened while running now reports what happens afterwards.
        var laterApproval = ShannonAgentTaskFixtures.waitingCommandApproval(now: migratedAt.addingTimeInterval(60))
        laterApproval = replacing(running.id, with: laterApproval)
        XCTAssertTrue(acknowledgements.needsNotice(laterApproval))
        var laterResult = replacing(running.id, with: ShannonAgentTaskFixtures.completed(now: migratedAt.addingTimeInterval(120)))
        laterResult.updatedAt = migratedAt.addingTimeInterval(120)
        XCTAssertTrue(acknowledgements.needsNotice(laterResult))

        // The migrated form is what is stored from now on.
        XCTAssertEqual(store.loadAcknowledgements(scopeKey: "owner-a", tasks: [], now: Date()), acknowledgements)
    }

    func testAcknowledgementsRoundTripAndPruneRemovedTasks() throws {
        let suiteName = "ShannonAgentTaskAttentionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ShannonAgentTaskStore(defaults: defaults)
        let kept = ShannonAgentTaskFixtures.completed()
        let removed = ShannonAgentTaskFixtures.completed()
        var acknowledgements = ShannonAgentTaskAcknowledgements()
        XCTAssertTrue(acknowledgements.markSeen(kept))
        XCTAssertTrue(acknowledgements.markSeen(removed))
        XCTAssertFalse(acknowledgements.markSeen(ShannonAgentTaskFixtures.waitingApproval()), "viewing never clears an approval")

        store.saveAcknowledgements(acknowledgements, scopeKey: "owner-a")
        var restored = store.loadAcknowledgements(scopeKey: "owner-a", tasks: [])
        XCTAssertEqual(restored, acknowledgements)
        XCTAssertEqual(store.loadAcknowledgements(scopeKey: "owner-b", tasks: []), ShannonAgentTaskAcknowledgements())

        restored.prune(keeping: [kept.id])
        XCTAssertFalse(restored.needsNotice(kept))
        XCTAssertTrue(restored.needsNotice(removed))
    }

    // MARK: The notice shows what is being approved

    func testNoticeShowsTheConcreteTargetAndOffersInPlaceApprovalOnlyWhenItFits() {
        let task = ShannonAgentTaskFixtures.waitingCommandApproval(command: "scripts/verify.sh api")
        let notice = ShannonAgentTaskNoticePresentation(task: task)
        XCTAssertEqual(notice.headline, "許可待ち：\(task.title)")
        XCTAssertEqual(notice.detail, "scripts/verify.sh api")
        XCTAssertTrue(notice.detailIsTarget)
        XCTAssertEqual(notice.quickApproval?.id, task.pendingApproval?.id)

        // Host titles are generic, so without a target there is nothing concrete to grant in place.
        var withoutTarget = task
        withoutTarget.pendingApproval?.resource = nil
        let generic = ShannonAgentTaskNoticePresentation(task: withoutTarget)
        XCTAssertEqual(generic.detail, "コマンド実行の許可")
        XCTAssertFalse(generic.detailIsTarget)
        XCTAssertNil(generic.quickApproval)

        var truncated = task
        truncated.pendingApproval?.resource = String(repeating: "a", count: 60) + "…"
        XCTAssertNil(ShannonAgentTaskNoticePresentation(task: truncated).quickApproval)

        var long = task
        long.pendingApproval?.resource = String(repeating: "x", count: ShannonAgentApproval.noticeTargetLimit + 1)
        XCTAssertNil(ShannonAgentTaskNoticePresentation(task: long).quickApproval)

        // At accessibility text sizes the notice keeps one line, so it cannot show the target.
        let compact = ShannonAgentTaskNoticePresentation(task: task, showsDetail: false)
        XCTAssertNil(compact.detail)
        XCTAssertNil(compact.quickApproval)
    }

    func testNetworkPermissionAndNonApprovalStatesNeverOfferInPlaceApproval() {
        var task = ShannonAgentTaskFixtures.waitingApproval()
        XCTAssertNil(ShannonAgentTaskNoticePresentation.quickApproval(for: task), "network needs the hold flow")
        task.pendingApproval?.kind = .fileChange
        task.pendingApproval?.resource = "/Users/owner/Project"
        XCTAssertNotNil(ShannonAgentTaskNoticePresentation.quickApproval(for: task))
        task.pendingApproval?.kind = .permission
        XCTAssertNil(ShannonAgentTaskNoticePresentation.quickApproval(for: task))

        task = ShannonAgentTaskFixtures.waitingCommandApproval()
        task.status = .running
        XCTAssertNil(ShannonAgentTaskNoticePresentation.quickApproval(for: task))
        task.status = .waitingApproval
        task.pendingApproval = nil
        XCTAssertNil(ShannonAgentTaskNoticePresentation.quickApproval(for: task))
    }

    func testNoticeForAStopNamesTheNextAction() {
        let notice = ShannonAgentTaskNoticePresentation(task: ShannonAgentTaskFixtures.needsOwner())
        XCTAssertEqual(notice.headline, "続きが必要：ログイン障害を調査")
        XCTAssertEqual(notice.detail, "次：iPhoneで再起動後にログインできるか確認して、結果を伝える")
        XCTAssertNil(notice.quickApproval)
    }

    func testFixtureApprovalsMirrorTheAgentHostTitles() {
        XCTAssertEqual(ShannonAgentTaskFixtures.waitingApproval().pendingApproval?.title, "ネットワーク接続の許可")
        XCTAssertEqual(ShannonAgentTaskFixtures.waitingCommandApproval().pendingApproval?.title, "コマンド実行の許可")
    }

    // MARK: Declining

    func testDecliningOneOperationKeepsTheTaskAndDecliningOnAnOlderHostStopsIt() async {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let id = model.installAgentTaskFixture(status: .waitingApproval)
        XCTAssertEqual(model.agentTask(id: id)?.pendingApproval?.denyStopsTask, false)
        await model.resolveAgentApproval(id, accepted: false)
        XCTAssertEqual(model.agentTask(id: id)?.status, .running)

        let olderID = model.installAgentTaskFixture(status: .waitingApproval)
        var older = model.agentTask(id: olderID)!
        older.pendingApproval?.denyContinues = nil
        model.upsertAgentTask(older)
        XCTAssertEqual(model.agentTask(id: olderID)?.pendingApproval?.denyStopsTask, true)
        await model.resolveAgentApproval(olderID, accepted: false)
        XCTAssertEqual(model.agentTask(id: olderID)?.status, .cancelled)
    }

    func testRemoteTaskDecodesPauseReasonAndDeclineBehaviourAndOlderPayloadsStillDecode() throws {
        let json = #"""
        {"task":{"id":"07EA7E66-BBF6-4B75-BFD3-DAFEB54F851E","conversationThreadID":"t","title":"配信",
        "goal":"g","status":"paused","summary":"s","currentAction":"実機で確認","pauseReason":"needs_owner",
        "pauseSequence":12,"plan":[],"timeline":[],"changes":[],"tests":[],
        "createdAt":"2026-09-04T00:00:00.000Z","updatedAt":"2026-09-04T00:01:00.000Z","latestSequence":12}}
        """#
        let paused = try ShannonAgentTask(remote: JSONDecoder().decode(ShannonAgentTaskEnvelopeDTO.self, from: Data(json.utf8)).task)
        XCTAssertEqual(paused.pauseReason, .needsOwner)
        XCTAssertEqual(paused.attention, .nextAction("12"))

        let approvalJSON = #"""
        {"task":{"id":"07EA7E66-BBF6-4B75-BFD3-DAFEB54F851E","conversationThreadID":"t","title":"配信",
        "goal":"g","status":"waiting_approval","summary":"s","plan":[],"timeline":[],"changes":[],"tests":[],
        "pendingApproval":{"id":"0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9","externalRequestID":"r1","kind":"command",
        "title":"コマンド実行の許可","reason":"必要","resource":"rm -rf build","denyContinues":true,
        "requestedAt":"2026-09-04T00:00:00.000Z"},
        "createdAt":"2026-09-04T00:00:00.000Z","updatedAt":"2026-09-04T00:01:00.000Z","latestSequence":3}}
        """#
        let waiting = try ShannonAgentTask(remote: JSONDecoder().decode(ShannonAgentTaskEnvelopeDTO.self, from: Data(approvalJSON.utf8)).task)
        XCTAssertEqual(waiting.pendingApproval?.denyStopsTask, false)
        XCTAssertEqual(waiting.attention, .approval("r1"))

        let older = approvalJSON.replacingOccurrences(of: #""denyContinues":true,"#, with: "")
        let legacy = try ShannonAgentTask(remote: JSONDecoder().decode(ShannonAgentTaskEnvelopeDTO.self, from: Data(older.utf8)).task)
        XCTAssertEqual(legacy.pendingApproval?.denyStopsTask, true)
    }

    // MARK: Proposals are never dropped silently

    func testAProposalThatReusesAStartedTaskIdentityStillAppearsAsItsOwnCard() {
        let model = ShannonConversationModel(usesDisplayCache: false)
        var started = ShannonAgentTaskFixtures.completed(threadID: "thread-a")
        started.title = "ログイン修正"
        started.goal = "ログイン画面を修正する"
        model.upsertAgentTask(started)
        let reused = ShannonUIBlockDTO(
            proposalId: started.id.uuidString, title: "別のバグ修正", goal: "別のバグを直す", risk: nil
        )

        model.installAgentTaskProposals([reused], threadID: "thread-a", sourceMessageID: UUID())

        let proposals = model.agentTasks.filter { $0.status == .proposed }
        XCTAssertEqual(proposals.map(\.title), ["別のバグ修正"])
        XCTAssertNotEqual(proposals.first?.id, started.id)
        XCTAssertEqual(model.agentTask(id: started.id)?.status, .completed, "durable work is never downgraded")

        // The same proposal delivered again refines the one card instead of adding another.
        model.installAgentTaskProposals([reused], threadID: "thread-a", sourceMessageID: UUID())
        XCTAssertEqual(model.agentTasks.filter { $0.status == .proposed }.count, 1)

        // An exact repeat of the started work is a redelivery, not a new proposal.
        let repeated = ShannonUIBlockDTO(
            proposalId: started.id.uuidString, title: started.title, goal: started.goal, risk: nil
        )
        model.installAgentTaskProposals([repeated], threadID: "thread-a", sourceMessageID: UUID())
        XCTAssertEqual(model.agentTasks.count, 2)
    }

    // MARK: Report and follow-ups for stopped and finished work

    func testReportListsChangesChecksAndUnresolvedFromDurableDataOnly() {
        let stopped = ShannonAgentTaskFixtures.needsOwner()
        let report = ShannonAgentTaskReport(task: stopped)
        XCTAssertEqual(report.changes.map(\.displayName), ["SessionStore.swift"])
        XCTAssertEqual(report.tests.count, 2)
        XCTAssertEqual(report.unresolved, [
            "検証「iOSアプリビルド」が失敗",
            "工程「修正案を検証」が未完了",
            "工程「テストして結果をまとめる」が未完了",
        ])
        XCTAssertTrue(ShannonAgentTaskReport.leadsRoom(for: stopped))

        let completed = ShannonAgentTaskReport(task: ShannonAgentTaskFixtures.completed())
        XCTAssertTrue(completed.unresolved.isEmpty, "a verified completion has no unresolved section")
        XCTAssertFalse(completed.isEmpty)

        let running = ShannonAgentTaskFixtures.running()
        XCTAssertTrue(ShannonAgentTaskReport(task: running).isEmpty)
        XCTAssertFalse(ShannonAgentTaskReport.leadsRoom(for: running))
    }

    func testFollowUpDraftsNameTheTaskAndCarryWhatIsLeft() {
        var failed = ShannonAgentTaskFixtures.needsOwner()
        failed.status = .failed
        XCTAssertEqual(
            ShannonAgentTaskFollowUp.fix.draft(for: failed),
            "「ログイン障害を調査」の結果で直してほしいところがあります。\n直してほしい点："
        )
        XCTAssertTrue(ShannonAgentTaskFollowUp.continuation.draft(for: failed)
            .hasPrefix("「ログイン障害を調査」の続きをお願いします。\n残っていること：検証「iOSアプリビルド」が失敗"))
        XCTAssertEqual(
            ShannonAgentTaskFollowUp.continuation.draft(for: ShannonAgentTaskFixtures.completed()),
            "「ログイン障害を調査」の続きをお願いします。\n続けてほしいこと："
        )
    }

    // MARK: One word per state

    func testEachStateHasOneWord() {
        XCTAssertEqual(ShannonAgentTaskStatus.allCases.map(\.japaneseName), [
            "提案", "準備中", "準備中", "作業中", "許可待ち", "一時停止中", "完了", "失敗", "中止",
        ])
        var failed = ShannonAgentTaskFixtures.completed()
        failed.status = .failed
        XCTAssertEqual(ShannonAgentTaskCardPresentation(task: failed).statusText, "失敗")
        XCTAssertEqual(ShannonAgentTaskCardPresentation(task: ShannonAgentTaskFixtures.needsOwner()).statusText, "続きが必要")
        XCTAssertEqual(ShannonAgentTaskCardPresentation(task: ShannonAgentTaskFixtures.needsOwner()).tone, .attention)
        XCTAssertEqual(ShannonAgentTaskRoomPresentation.subtitle(for: ShannonAgentTaskFixtures.needsOwner()), "続きが必要・2/4工程")
        XCTAssertEqual(ShannonAgentTaskRoomPresentation.approvalHeader, "シャノンが許可を待っています")
    }

    func testOverviewAttentionFilterIncludesApprovalsStopsAndFailures() {
        var failed = ShannonAgentTaskFixtures.completed()
        failed.status = .failed
        var ownerPaused = ShannonAgentTaskFixtures.running()
        ownerPaused.status = .paused
        ownerPaused.pauseReason = .owner
        let tasks = [
            ShannonAgentTaskFixtures.waitingApproval(), ShannonAgentTaskFixtures.needsOwner(), failed,
            ownerPaused, ShannonAgentTaskFixtures.running(), ShannonAgentTaskFixtures.completed(),
        ]
        let projection = ShannonAgentTaskOverviewProjection(tasks: tasks, filter: .attention)
        XCTAssertEqual(projection.active.count, 2)
        XCTAssertEqual(projection.finished.map(\.status), [.failed])
        XCTAssertEqual(ShannonAgentTaskOverviewFilter.allCases.map(\.title), ["すべて", "対応待ち", "進行中", "提案", "終了"])
    }

    private func replacing(_ id: UUID, with source: ShannonAgentTask) -> ShannonAgentTask {
        ShannonAgentTask(
            id: id,
            conversationThreadID: source.conversationThreadID,
            title: source.title,
            goal: source.goal,
            status: source.status,
            summary: source.summary,
            currentAction: source.currentAction,
            pauseReason: source.pauseReason,
            pauseSequence: source.pauseSequence,
            plan: source.plan,
            timeline: source.timeline,
            pendingApproval: source.pendingApproval,
            changes: source.changes,
            tests: source.tests,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt
        )
    }
}

final class ShannonFailureCopyTests: XCTestCase {
    func testEachCauseGetsItsOwnActionableCopyAndNoneMentionsALocalAPI() {
        let cases: [(Error, Int, String)] = [
            (URLError(.notConnectedToInternet), 10, "インターネットにつながっていません。接続を確認して「再送」してください。"),
            (URLError(.timedOut), 10, "シャノンの返事が時間内に届きませんでした。少し待って「再送」してください。"),
            (URLError(.cannotConnectToHost), 10, "シャノンのサーバーに接続できません。少し待って「再送」してください。"),
            (ShannonAPIError.rejected(status: 400), 8_001, "メッセージが長すぎます（8,000文字まで）。分けて送ってください。"),
            (ShannonAPIError.rejected(status: 400), 10, "この内容は送信できませんでした。添付と文字数を確認してください。"),
            (ShannonAPIError.rejected(status: 413), 10, "添付を含めた内容が大きすぎます。添付を減らすか、分けて送ってください。"),
            (ShannonAPIError.rejected(status: 429), 10, "いま混み合っています。少し待って「再送」してください。"),
            (ShannonAPIError.rejected(status: 401), 10, "この端末の接続が無効になっています。設定の「接続」からつなぎ直してください。"),
            (ShannonAPIError.rejected(status: 502), 10, "シャノン側で返事を作れませんでした。少し待って「再送」してください。"),
            (ShannonAPIError.rejected(status: 504), 10, "シャノンの返事が時間内に届きませんでした。少し待って「再送」してください。"),
            (CancellationError(), 10, "送信できませんでした。少し待って「再送」してください。"),
        ]
        for (error, length, expected) in cases {
            XCTAssertEqual(ShannonFailureCopy.send(error, messageLength: length), expected)
        }
        XCTAssertEqual(
            ShannonFailureCopy.send(CancellationError(), messageLength: 0, includesPhoto: true),
            "写真を確認または送信できませんでした。「再送」できます。"
        )
        let everyMessage = cases.map { ShannonFailureCopy.send($0.0, messageLength: $0.1) }
            + ([URLError(.notConnectedToInternet), ShannonAPIError.rejected(status: 409), ShannonAPIError.rejected(status: 500)] as [Error])
                .map { ShannonFailureCopy.agentTaskStart($0) }
        XCTAssertFalse(everyMessage.contains { $0.contains("ローカルAPI") || $0.contains("API") })
        XCTAssertEqual(
            ShannonFailureCopy.agentTaskStart(ShannonAPIError.rejected(status: 409)),
            "選んだ実行先がいま使えないため、作業を開始できませんでした。実行先を選び直してください。"
        )
    }

    @MainActor
    func testAFailedSendTellsTheOwnerWhy() async {
        let model = ShannonConversationModel(client: FailingSendClient(error: URLError(.notConnectedToInternet)), usesDisplayCache: false)
        model.draft = "相談したいことがある"
        await model.sendDraft()
        XCTAssertEqual(model.errorMessage, "インターネットにつながっていません。接続を確認して「再送」してください。")
        XCTAssertTrue(model.hasFailedMessage)
    }
}

private struct FailingSendClient: ShannonAPIClientProtocol {
    let error: URLError

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw error
    }
}
