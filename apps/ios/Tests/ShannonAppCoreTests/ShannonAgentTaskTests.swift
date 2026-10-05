import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonAgentTaskTests: XCTestCase {
    func testAppleReleaseTaskStartsAsSevenGateProposal() {
        let task = ShannonAppleReleaseTaskFactory.make(target: .iOS, threadID: "release-thread")

        XCTAssertEqual(task.status, .proposed)
        XCTAssertEqual(task.conversationThreadID, "release-thread")
        XCTAssertEqual(task.projectHint, "shannon-ios")
        XCTAssertEqual(task.hostHint, ShannonAgentRoutingPreference.auto.rawValue)
        XCTAssertEqual(task.plan.map(\.title), [
            "Build", "Archive", "Upload", "Processing", "Assignment", "Install", "Smoke"
        ])
        XCTAssertTrue(task.plan.allSatisfy { $0.status == .pending })
        XCTAssertTrue(task.goal.contains("未確認を完了扱いにしない"))
        XCTAssertTrue(task.goal.contains("実機確認を待って"))
    }

    func testStateMachineAllowsExpectedPathAndLocksTerminalState() {
        var task = ShannonAgentTaskFixtures.proposed()

        XCTAssertTrue(task.canTransition(to: .running))
        XCTAssertFalse(task.canTransition(to: .completed))

        task.status = .running
        XCTAssertTrue(task.canTransition(to: .waitingApproval))
        XCTAssertTrue(task.canTransition(to: .paused))
        XCTAssertTrue(task.canTransition(to: .completed))

        task.status = .completed
        XCTAssertFalse(task.canTransition(to: .running))
        XCTAssertFalse(task.canTransition(to: .cancelled))
    }

    func testProgressUsesCompletedPlanItemsOnly() {
        let task = ShannonAgentTaskFixtures.running()

        XCTAssertEqual(task.completedPlanCount, 2)
        XCTAssertEqual(task.progressFraction, 0.5)
    }

    func testMobileOverviewSeparatesActiveProposedAndFinishedByRecency() {
        var active = ShannonAgentTaskFixtures.running()
        active.updatedAt = Date(timeIntervalSince1970: 30)
        var proposed = ShannonAgentTaskFixtures.proposed()
        proposed.updatedAt = Date(timeIntervalSince1970: 20)
        var finished = ShannonAgentTaskFixtures.running()
        finished.status = .completed
        finished.updatedAt = Date(timeIntervalSince1970: 10)

        let projection = ShannonAgentTaskOverviewProjection(tasks: [finished, proposed, active])

        XCTAssertEqual(projection.active.map(\.id), [active.id])
        XCTAssertEqual(projection.proposed.map(\.id), [proposed.id])
        XCTAssertEqual(projection.finished.map(\.id), [finished.id])
    }

    func testMobileOverviewSearchFilterPinAndArchiveStayMutuallyExclusive() {
        var pinned = ShannonAgentTaskFixtures.running()
        pinned.title = "Shannonの配信"
        pinned.updateManagement(isPinned: true)
        var archived = ShannonAgentTaskFixtures.completed()
        archived.title = "Aetherの監査"
        archived.updateManagement(isArchived: true)
        var approval = ShannonAgentTaskFixtures.waitingApproval()
        approval.title = "Voyagerの承認"

        let all = ShannonAgentTaskOverviewProjection(tasks: [archived, approval, pinned])
        XCTAssertEqual(all.pinned.map(\.id), [pinned.id])
        XCTAssertEqual(all.active.map(\.id), [approval.id])
        XCTAssertEqual(all.archived.map(\.id), [archived.id])

        let attention = ShannonAgentTaskOverviewProjection(
            tasks: [archived, approval, pinned], query: "Voyager", filter: .attention
        )
        XCTAssertEqual(attention.active.map(\.id), [approval.id])
        XCTAssertTrue(attention.pinned.isEmpty)
        XCTAssertTrue(attention.archived.isEmpty)
    }

    func testUserFacingStagesCollapseIntermediateTaskStatuses() {
        var task = ShannonAgentTaskFixtures.proposed()
        XCTAssertEqual(task.stage, .proposal)
        XCTAssertEqual(task.stageProgress.map(\.state), [.current, .pending, .pending, .pending, .pending])

        task.status = .queued
        XCTAssertEqual(task.stage, .preparation)
        XCTAssertEqual(task.stageProgress.map(\.state), [.completed, .current, .pending, .pending, .pending])

        task.status = .starting
        XCTAssertEqual(task.stage, .preparation)

        task.status = .running
        XCTAssertEqual(task.stage, .work)
        XCTAssertEqual(task.stageProgress.map(\.state), [.completed, .completed, .current, .pending, .pending])

        task.status = .waitingApproval
        XCTAssertEqual(task.stage, .review)
        XCTAssertEqual(task.stageProgress.map(\.state), [.completed, .completed, .completed, .current, .pending])

        task.status = .completed
        XCTAssertEqual(task.stage, .completion)
        XCTAssertEqual(task.stageProgress.map(\.state), Array(repeating: .completed, count: 5))
    }

    func testCommandActivityReportsRunningAndCompletedStatesWithoutRawCommandText() {
        var task = ShannonAgentTaskFixtures.running()
        task.timeline.append(.init(
            sequence: 9,
            title: "自動テストを実行中",
            activity: .init(kind: .command, status: .running)
        ))

        XCTAssertEqual(task.latestCommandActivity?.activity?.status, .running)
        XCTAssertEqual(task.stageDescription, "シャノンがコマンドを実行しています")

        task.timeline.append(.init(
            sequence: 10,
            title: "コマンドの実行を完了",
            activity: .init(kind: .command, status: .completed)
        ))

        XCTAssertEqual(task.latestCommandActivity?.activity?.status, .completed)
        XCTAssertEqual(task.stageDescription, "シャノンがコマンドの結果を確認しています")
    }

    func testFixturesKeepTimelineOrderAndStatusExpression() {
        let task = ShannonAgentTaskFixtures.waitingApproval()
        let sequences = task.timeline.map(\.sequence)

        XCTAssertEqual(sequences, sequences.sorted())
        XCTAssertEqual(Set(sequences).count, sequences.count)
        XCTAssertEqual(task.expression, .concerned)
        XCTAssertNotNil(task.pendingApproval)
    }

    func testStoreRoundTripsAndSeparatesScopes() throws {
        let suiteName = "ShannonAgentTaskTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ShannonAgentTaskStore(defaults: defaults)
        var task = ShannonAgentTaskFixtures.running(threadID: "thread-a")
        task.title = "実タスクを調査"

        store.save([task], scopeKey: "owner-a")

        XCTAssertEqual(store.load(scopeKey: "owner-a"), [task])
        XCTAssertTrue(store.load(scopeKey: "owner-b").isEmpty)
        var acknowledgements = ShannonAgentTaskAcknowledgements()
        acknowledgements.markSeen(ShannonAgentTaskFixtures.completed())
        store.saveAcknowledgements(acknowledgements, scopeKey: "owner-a")
        XCTAssertEqual(store.loadAcknowledgements(scopeKey: "owner-a", tasks: []), acknowledgements)
        store.remove(scopeKey: "owner-a")
        XCTAssertTrue(store.load(scopeKey: "owner-a").isEmpty)
        XCTAssertEqual(store.loadAcknowledgements(scopeKey: "owner-a", tasks: []), ShannonAgentTaskAcknowledgements())
    }

    func testStoreDropsTheLegacyDebugPreviewFromPersistedTasks() throws {
        let suiteName = "ShannonAgentTaskTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ShannonAgentTaskStore(defaults: defaults)

        store.save([ShannonAgentTaskFixtures.running()], scopeKey: "owner-a")

        XCTAssertTrue(store.load(scopeKey: "owner-a").isEmpty)
    }

    func testRemoteTaskAcceptsCompactChangeAndTestIdentifiers() throws {
        let data = try XCTUnwrap(Self.compactIdentifierTaskJSON.data(using: .utf8))
        let envelope = try JSONDecoder().decode(ShannonAgentTaskEnvelopeDTO.self, from: data)

        let task = try ShannonAgentTask(remote: envelope.task)

        XCTAssertEqual(task.changes.first?.id.uuidString, "19FB986E-C36D-5DE2-F30F-49E3F13E4BA1")
        XCTAssertEqual(task.tests.first?.id.uuidString, "DC4D012E-B1B6-FC84-4ED8-6D0291AA7ECB")
        XCTAssertEqual(task.latestCommandActivity?.activity?.status, .completed)
    }

    func testWorkspaceProjectDecodesOlderCatalogAndDefaultsSnapshotFields() throws {
        let data = try XCTUnwrap(#"{"key":"shannon-ios","availableHostIds":["shannon-mac"]}"#.data(using: .utf8))

        let project = try JSONDecoder().decode(ShannonAgentProjectDTO.self, from: data)

        XCTAssertEqual(project.key, "shannon-ios")
        XCTAssertEqual(project.availableHostIds, ["shannon-mac"])
        XCTAssertFalse(project.isGitRepository)
        XCTAssertNil(project.currentBranch)
        XCTAssertTrue(project.files.isEmpty)
        XCTAssertTrue(project.changes.isEmpty)
    }

    func testDevelopmentOptionsPreferResolvedHostAndNormalizeUnsupportedModelSettings() {
        let local = ShannonAgentHostDTO(
            hostId: "local",
            displayName: "このMac",
            kind: .local,
            capabilities: [],
            projects: ["aether"],
            models: [],
            status: .available,
            lastSeenAt: "2026-09-14T00:00:00Z"
        )
        let cloud = ShannonAgentHostDTO(
            hostId: "cloud",
            displayName: "Cloud Agent Host",
            kind: .cloud,
            capabilities: [],
            projects: ["aether"],
            models: [],
            status: .available,
            lastSeenAt: "2026-09-14T00:00:00Z"
        )
        let model = ShannonAgentModelDTO(
            id: "codex-main",
            displayName: "Codex Main",
            supportedReasoningEfforts: [.medium, .high],
            defaultReasoningEffort: .high
        )

        XCTAssertEqual(
            ShannonAgentDevelopmentOptions.selectedHost(
                from: [cloud, local],
                preference: .auto,
                resolvedHostID: "local"
            )?.id,
            "local"
        )
        XCTAssertEqual(
            ShannonAgentDevelopmentOptions.normalizedModelID("retired", models: [model]),
            ""
        )
        XCTAssertEqual(
            ShannonAgentDevelopmentOptions.normalizedReasoningEffort(
                .ultra,
                modelID: model.id,
                models: [model]
            ),
            .high
        )
    }

    func testWorkspaceAvailabilityFailsClosedUntilProjectAndHostAreKnown() {
        let host = ShannonAgentHostDTO(
            hostId: "local",
            displayName: "このMac",
            kind: .local,
            capabilities: [],
            projects: ["shannon-ios"],
            models: [],
            status: .available,
            lastSeenAt: "2026-09-15T00:00:00Z"
        )
        let project = ShannonAgentProjectDTO(
            key: "shannon-ios",
            availableHostIds: [host.id]
        )

        XCTAssertFalse(ShannonAgentWorkspaceAvailability.canStart(
            workspace: .unavailable,
            selectedHost: nil
        ))
        XCTAssertFalse(ShannonAgentWorkspaceAvailability.canStart(
            workspace: .init(
                routing: .init(defaultPreference: .auto, resolvedHostId: host.id, explanation: ""),
                hosts: [host],
                projects: [],
                models: []
            ),
            selectedHost: host
        ))
        XCTAssertTrue(ShannonAgentWorkspaceAvailability.canStart(
            workspace: .init(
                routing: .init(defaultPreference: .auto, resolvedHostId: host.id, explanation: ""),
                hosts: [host],
                projects: [project],
                models: []
            ),
            selectedHost: host
        ))
    }

    func testWorkspaceAvailabilityRejectsOfflineHost() {
        let host = ShannonAgentHostDTO(
            hostId: "local",
            displayName: "このMac",
            kind: .local,
            capabilities: [],
            projects: ["shannon-ios"],
            models: [],
            status: .offline,
            lastSeenAt: "2026-09-15T00:00:00Z"
        )
        let workspace = ShannonAgentWorkspaceCatalogDTO(
            routing: .init(defaultPreference: .local, resolvedHostId: host.id, explanation: ""),
            hosts: [host],
            projects: [.init(key: "shannon-ios", availableHostIds: [host.id])],
            models: []
        )

        XCTAssertFalse(ShannonAgentWorkspaceAvailability.canStart(
            workspace: workspace,
            selectedHost: host
        ))
    }

    func testCompletedTaskRemainsVisibleUntilAcknowledged() {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let taskID = model.installAgentTaskFixture(status: .completed)

        XCTAssertEqual(model.latestAgentTaskNotice?.id, taskID)
        XCTAssertEqual(model.unreadAgentTaskCount, 1)
        XCTAssertEqual(model.totalBadgeCount, 1)

        model.acknowledgeAgentTask(taskID)

        XCTAssertNil(model.latestAgentTaskNotice)
        XCTAssertEqual(model.unreadAgentTaskCount, 0)
    }

    func testAllActiveTasksRemainInTheCommonTaskMenuAfterAcknowledgement() {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let waitingID = model.installAgentTaskFixture(status: .waitingApproval)
        let runningID = model.installAgentTaskFixture(status: .running)

        model.acknowledgeAgentTask(waitingID)

        XCTAssertEqual(Set(model.agentTaskNotices.map(\.id)), Set([waitingID, runningID]))
        // Looking at a pending approval is not deciding it, so its notice stays.
        XCTAssertEqual(model.latestAgentTaskNotice?.id, waitingID)
    }

    func testRunningTaskUsesHeaderMenuWithoutOccupyingComposerArea() {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let runningID = model.installAgentTaskFixture(status: .running)

        XCTAssertEqual(model.agentTaskNotices.map(\.id), [runningID])
        XCTAssertNil(model.latestAgentTaskNotice)
    }

    func testApprovalStillProducesAnUrgentComposerBanner() {
        let model = ShannonConversationModel(usesDisplayCache: false)
        let waitingID = model.installAgentTaskFixture(status: .waitingApproval)

        XCTAssertEqual(model.latestAgentTaskNotice?.id, waitingID)
    }

    func testApprovalFailureRestoresTheCardAndExposesAnInlineError() async {
        let task = ShannonAgentTaskFixtures.waitingApproval()
        let client = ApprovalCommandClient(task: task, shouldFail: true)
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        await model.synchronizeAgentTasks()

        await model.resolveAgentApproval(task.id, accepted: true)

        XCTAssertEqual(model.agentTask(id: task.id)?.status, .waitingApproval)
        XCTAssertNotNil(model.agentTask(id: task.id)?.pendingApproval)
        XCTAssertFalse(model.isAgentTaskActionInFlight(task.id))
        XCTAssertEqual(
            model.agentTaskActionError(task.id),
            "判断を送信できませんでした。通信状態を確認してもう一度お試しください。"
        )
    }

    func testApprovalSuccessUsesTheCurrentExternalRequestAndUpdatesImmediately() async {
        let task = ShannonAgentTaskFixtures.waitingApproval()
        let client = ApprovalCommandClient(task: task, shouldFail: false)
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        await model.synchronizeAgentTasks()

        await model.resolveAgentApproval(task.id, accepted: true, forSession: true)

        XCTAssertEqual(model.agentTask(id: task.id)?.status, .starting)
        XCTAssertNil(model.agentTask(id: task.id)?.pendingApproval)
        XCTAssertNil(model.agentTaskActionError(task.id))
        let command = await client.command
        XCTAssertEqual(command?.type, "resolve_approval")
        XCTAssertEqual(command?.payload["decision"], "allow_session")
        XCTAssertEqual(command?.payload["externalRequestID"], task.pendingApproval?.externalRequestID)
    }

    func testApprovalDecidesOnlyTheRequestThatWasOnScreen() async {
        let task = ShannonAgentTaskFixtures.waitingApproval()
        let client = ApprovalCommandClient(task: task, shouldFail: false)
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        await model.synchronizeAgentTasks()

        // A press rendered for another (older) request sends nothing and reads the task again.
        await model.resolveAgentApproval(task.id, accepted: true, requestID: "an-earlier-request")
        let ignored = await client.command
        XCTAssertNil(ignored)
        XCTAssertEqual(model.agentTask(id: task.id)?.status, .waitingApproval)

        // The request on screen is the pending one: it is decided.
        await model.resolveAgentApproval(task.id, accepted: true, requestID: task.pendingApproval?.externalRequestID)
        let command = await client.command
        XCTAssertEqual(command?.payload["externalRequestID"], task.pendingApproval?.externalRequestID)
    }

    func testStoppingRemoteTaskSendsADurableCancelCommand() async {
        let task = ShannonAgentTaskFixtures.running()
        let client = ApprovalCommandClient(task: task, shouldFail: false)
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        await model.synchronizeAgentTasks()

        await model.cancelAgentTask(task.id)

        let command = await client.command
        XCTAssertEqual(command?.type, "interrupt")
        XCTAssertEqual(command?.payload["cancel"], "true")
    }

    func testConversationLifecycleSupportsStartSteerPauseAndApproval() async {
        let model = ShannonConversationModel(
            messages: [ConversationMessage(role: .shannon, text: "調べようか？")],
            usesDisplayCache: false
        )
        let taskID = model.installAgentTaskFixture(status: .proposed)

        await model.startAgentTask(taskID)
        XCTAssertEqual(model.agentTask(id: taskID)?.status, .running)

        await model.steerAgentTask(taskID, instruction: "履歴を消さない方針で進めて")
        XCTAssertEqual(model.agentTask(id: taskID)?.currentAction, "履歴を消さない方針で進めて")

        await model.toggleAgentTaskPause(taskID)
        XCTAssertEqual(model.agentTask(id: taskID)?.status, .paused)
        await model.toggleAgentTaskPause(taskID)
        XCTAssertEqual(model.agentTask(id: taskID)?.status, .running)

        model.advanceAgentTaskFixture(taskID)
        XCTAssertEqual(model.agentTask(id: taskID)?.status, .waitingApproval)
        await model.resolveAgentApproval(taskID, accepted: true, forSession: true)
        XCTAssertEqual(model.agentTask(id: taskID)?.status, .running)
        XCTAssertNil(model.agentTask(id: taskID)?.pendingApproval)
    }

    func testStructuredChatBlockCreatesProposalAttachedToReply() async throws {
        let proposalID = UUID()
        let cognitiveIntentID = "goal-personality"
        let response = AgentTaskResponseFixtures.response(uiBlocks: [
            ShannonUIBlockDTO(
                proposalId: proposalID.uuidString,
                cognitiveIntentID: cognitiveIntentID,
                title: "不具合を調べる",
                goal: "会話履歴を残したまま接続を直す",
                risk: "変更前に確認する"
            ),
        ])
        let model = ShannonConversationModel(
            client: AgentTaskResponseClient(response: response),
            usesDisplayCache: false
        )
        model.draft = "直してほしい"

        await model.sendDraft()

        let task = try XCTUnwrap(model.agentTask(id: proposalID))
        XCTAssertEqual(task.status, .proposed)
        XCTAssertEqual(task.conversationThreadID, response.threadId)
        XCTAssertEqual(task.sourceMessageID, model.messages.last?.id)
        XCTAssertEqual(task.cognitiveIntentID, cognitiveIntentID)
        XCTAssertTrue(task.summary.contains("変更前に確認する"))
    }

    private static let compactIdentifierTaskJSON = #"""
    {
      "task": {
        "id": "07EA7E66-BBF6-4B75-BFD3-DAFEB54F851E",
        "conversationThreadID": "thread-a",
        "title": "実タスク",
        "goal": "取得する",
        "status": "completed",
        "summary": "完了",
        "plan": [],
        "timeline": [{
          "id": "timeline-1",
          "sequence": 1,
          "title": "コマンドの実行を完了",
          "occurredAt": "2026-09-04T00:00:00.000Z",
          "tone": "progress",
          "activity": { "kind": "command", "status": "completed" }
        }],
        "changes": [{
          "id": "19fb986ec36d5de2f30f49e3f13e4ba1",
          "displayName": "View.swift",
          "summary": "変更",
          "additions": 1,
          "deletions": 0
        }],
        "tests": [{
          "id": "dc4d012eb1b6fc844ed86d0291aa7ecb",
          "name": "Swiftテスト",
          "status": "passed"
        }],
        "createdAt": "2026-09-04T00:00:00.000Z",
        "updatedAt": "2026-09-04T00:01:00.000Z",
        "latestSequence": 1
      }
    }
    """#
}

private struct AgentTaskResponseClient: ShannonAPIClientProtocol {
    let response: ChatResponseDTO

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        response
    }
}

private actor ApprovalCommandClient: ShannonAPIClientProtocol {
    struct Command: Sendable {
        let type: String
        let payload: [String: String]
    }

    let task: ShannonAgentTask
    let shouldFail: Bool
    private(set) var command: Command?

    init(task: ShannonAgentTask, shouldFail: Bool) {
        self.task = task
        self.shouldFail = shouldFail
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadAgentTasks(scopeKey: String) async throws -> [ShannonAgentTask] {
        [task]
    }

    func sendAgentTaskCommand(
        scopeKey: String,
        taskID: UUID,
        type: String,
        payload: [String: String],
        idempotencyKey: String
    ) async throws -> ShannonAgentTask {
        command = Command(type: type, payload: payload)
        if shouldFail { throw ShannonAPIError.invalidResponse }
        var updated = task
        updated.status = .starting
        updated.summary = "判断を受け取り、続きを始めています。"
        updated.currentAction = "操作結果をMacへ送信中"
        updated.pendingApproval = nil
        updated.updatedAt = Date()
        return updated
    }
}

private enum AgentTaskResponseFixtures {
    static func response(uiBlocks: [ShannonUIBlockDTO]) -> ChatResponseDTO {
        ChatResponseDTO(
            mode: "fixture",
            reply: "調べて直す作業として進められるよ。",
            threadId: "task-thread",
            snapshotVersion: 1,
            messageEmotion: ShannonMessageEmotionDTO(
                valence: 0.2,
                arousal: 0.4,
                openness: 0.5,
                expression: .determined
            ),
            systemPrompt: "fixture",
            state: CompanionStateDTO(
                scopeKey: "local-owner",
                version: 1,
                updatedAt: "2026-09-04T00:00:00.000Z",
                temperament: ShannonTemperamentDTO(
                    curiosity: 0.65,
                    initiative: 0.25,
                    closeness: 0.15,
                    calmness: 0.6,
                    needForContinuity: 0.7,
                    confidenceAboutUser: 0.05
                ),
                emotion: ShannonEmotionDTO(valence: 0.2, arousal: 0.4, openness: 0.5),
                interests: [],
                userFacts: [],
                activeMemories: []
            ),
            uiBlocks: uiBlocks
        )
    }
}
