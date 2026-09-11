import Foundation
import Observation

extension ShannonConversationModel {
    @discardableResult
    public func installAgentTaskFixture(status: ShannonAgentTaskStatus = .proposed) -> UUID {
        let threadID = selectedThreadId ?? "local-preview"
        let sourceMessageID = messages.last(where: { $0.role == .shannon })?.id
        let task: ShannonAgentTask
        switch status {
        case .proposed, .queued, .starting, .paused, .failed, .cancelled:
            var proposed = ShannonAgentTaskFixtures.proposed(
                threadID: threadID,
                sourceMessageID: sourceMessageID
            )
            proposed.status = status
            task = proposed
        case .running:
            task = ShannonAgentTaskFixtures.running(threadID: threadID, sourceMessageID: sourceMessageID)
        case .waitingApproval:
            task = ShannonAgentTaskFixtures.waitingApproval(threadID: threadID, sourceMessageID: sourceMessageID)
        case .completed:
            task = ShannonAgentTaskFixtures.completed(threadID: threadID, sourceMessageID: sourceMessageID)
        }
        upsertAgentTask(task)
        previewAgentTaskIDs.insert(task.id)
        return task.id
    }

    public func startAgentTask(_ id: UUID) async {
        guard var task = agentTask(id: id), task.canTransition(to: .running) else { return }
        if !previewAgentTaskIDs.contains(id) {
            guard !pendingAgentTaskActionIDs.contains(id) else { return }
            pendingAgentTaskActionIDs.insert(id)
            defer { pendingAgentTaskActionIDs.remove(id) }
            let previous = task
            task.status = .queued
            task.summary = "作業をお願いしているところ。"
            task.currentAction = "作業環境の空きを確認中"
            task.updatedAt = Date()
            upsertAgentTask(task)
            do {
                let remote = try await client.createAgentTask(
                    scopeKey: scopeKey,
                    task: previous,
                    idempotencyKey: "ios-start-\(id.uuidString.lowercased())"
                )
                upsertAgentTask(remote)
            } catch {
                upsertAgentTask(previous)
                errorMessage = "作業を開始できませんでした。接続を確認してもう一度お試しください。"
            }
            return
        }
        let fixture = ShannonAgentTaskFixtures.running(
            threadID: task.conversationThreadID,
            sourceMessageID: task.sourceMessageID
        )
        task.status = .running
        task.summary = fixture.summary
        task.currentAction = fixture.currentAction
        task.plan = fixture.plan
        task.timeline = fixture.timeline
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func cancelAgentTask(_ id: UUID) async {
        guard var task = agentTask(id: id), task.canTransition(to: .cancelled) else { return }
        if task.status != .proposed && !previewAgentTaskIDs.contains(id) {
            await performAgentTaskCommand(
                id,
                type: "interrupt",
                payload: ["cancel": "true"],
                failureMessage: "作業を中止できませんでした。通信状態を確認してもう一度お試しください。",
                optimisticUpdate: { optimistic in
                    optimistic.summary = "停止を送信しています。"
                    optimistic.currentAction = "作業環境へ停止命令を送信中"
                }
            )
            return
        }
        task.status = .cancelled
        task.summary = "この作業は始めないことにした。"
        task.currentAction = nil
        task.pendingApproval = nil
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func toggleAgentTaskPause(_ id: UUID) async {
        guard var task = agentTask(id: id) else { return }
        let target: ShannonAgentTaskStatus = task.status == .paused ? .running : .paused
        guard task.canTransition(to: target) else { return }
        if !previewAgentTaskIDs.contains(id) {
            await performAgentTaskCommand(
                id,
                type: task.status == .paused ? "resume" : "interrupt",
                payload: [:],
                failureMessage: task.status == .paused ? "作業を再開できませんでした。" : "作業を一時停止できませんでした。"
            )
            return
        }
        task.status = target
        task.summary = target == .paused ? "ここでいったん止まってる。" : "作業を再開した。"
        task.currentAction = target == .paused ? nil : "既存の対話履歴を壊さないか確認中"
        task.timeline.append(.init(
            sequence: nextAgentSequence(task),
            title: target == .paused ? "ユーザーが一時停止" : "作業を再開",
            tone: target == .paused ? .warning : .progress
        ))
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func resolveAgentApproval(_ id: UUID, accepted: Bool, forSession: Bool = false) async {
        guard var task = agentTask(id: id), task.status == .waitingApproval else { return }
        if !previewAgentTaskIDs.contains(id) {
            let decision = accepted ? (forSession ? "allow_session" : "allow_once") : "deny"
            if task.pendingApproval == nil {
                await synchronizeAgentTask(id)
                guard let refreshed = agentTask(id: id), refreshed.status == .waitingApproval else {
                    agentTaskActionErrors[id] = "最新の作業状態を取得できませんでした。もう一度お試しください。"
                    return
                }
                task = refreshed
            }
            guard let externalRequestID = task.pendingApproval?.externalRequestID else {
                agentTaskActionErrors[id] = "許可内容を取得できませんでした。作業一覧から開き直してください。"
                return
            }
            await performAgentTaskCommand(
                id,
                type: "resolve_approval",
                payload: ["decision": decision, "externalRequestID": externalRequestID],
                failureMessage: "判断を送信できませんでした。通信状態を確認してもう一度お試しください。",
                optimisticUpdate: { optimistic in
                    optimistic.summary = accepted ? "許可を送信しています。" : "判断を送信しています。"
                    optimistic.currentAction = "作業環境へ判断を送信中"
                }
            )
            return
        }
        task.pendingApproval = nil
        task.status = accepted ? .running : .cancelled
        task.summary = accepted ? "許可を受け取った。続きから進めるね。" : "許可されなかったので、ここで止めた。"
        task.currentAction = accepted ? "接続テストを実行中" : nil
        task.timeline.append(.init(
            sequence: nextAgentSequence(task),
            title: accepted
                ? (forSession ? "ユーザーがこの作業中の操作を許可" : "ユーザーが今回の操作を許可")
                : "ユーザーが操作を許可しなかった",
            tone: accepted ? .progress : .warning
        ))
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func steerAgentTask(_ id: UUID, instruction: String) async {
        let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              var task = agentTask(id: id),
              task.status == .running || task.status == .paused
        else { return }
        if !previewAgentTaskIDs.contains(id) {
            await performAgentTaskCommand(
                id,
                type: "steer",
                payload: ["instruction": trimmed],
                failureMessage: "追加の指示を送信できませんでした。"
            )
            return
        }
        if task.status == .paused { task.status = .running }
        task.summary = "追加の指示を受け取った。"
        task.currentAction = trimmed
        task.timeline.append(.init(
            sequence: nextAgentSequence(task),
            title: "ユーザーから追加の指示",
            detail: trimmed,
            tone: .progress
        ))
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func synchronizeAgentTasks() async {
        do {
            let remoteTasks = try await client.loadAgentTasks(scopeKey: scopeKey)
            let remoteIDs = Set(remoteTasks.map(\.id))
            let localOnly = agentTasks.filter {
                ($0.status == .proposed || previewAgentTaskIDs.contains($0.id)) && !remoteIDs.contains($0.id)
            }
            agentTasks = (remoteTasks + localOnly).sorted { $0.updatedAt > $1.updatedAt }
            persistAgentTasks()
        } catch {
            // The on-device projection remains usable while the API is offline.
        }
    }

    public func synchronizeAgentTask(_ id: UUID) async {
        guard !previewAgentTaskIDs.contains(id), let current = agentTask(id: id) else { return }
        do {
            let sequence = current.timeline.map(\.sequence).max()
            if let remote = try await client.loadAgentTask(scopeKey: scopeKey, taskID: id, afterSequence: sequence) {
                upsertAgentTask(remote)
            }
        } catch {
            // Polling is best effort; command actions surface their own errors.
        }
    }

    public func acknowledgeAgentTask(_ id: UUID) {
        acknowledgedAgentTaskIDs.insert(id)
        agentTaskStore?.saveAcknowledgedTaskIDs(acknowledgedAgentTaskIDs, scopeKey: scopeKey)
    }

    public func openAgentTaskNotification(_ id: UUID) async {
        await synchronizeAgentTasks()
        guard agentTask(id: id) != nil else { return }
        acknowledgeAgentTask(id)
        requestedAgentTaskPresentationID = id
        agentTaskPresentationRevision &+= 1
        talkPresentationRevision &+= 1
    }

    public func advanceAgentTaskFixture(_ id: UUID) {
        guard let task = agentTask(id: id) else { return }
        let next: ShannonAgentTask
        switch task.status {
        case .proposed, .queued, .starting, .paused:
            next = ShannonAgentTaskFixtures.running(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        case .running:
            next = ShannonAgentTaskFixtures.waitingApproval(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        case .waitingApproval:
            next = ShannonAgentTaskFixtures.completed(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        case .completed, .failed, .cancelled:
            next = ShannonAgentTaskFixtures.proposed(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        }
        var replacement = ShannonAgentTask(
            id: task.id,
            conversationThreadID: next.conversationThreadID,
            sourceMessageID: next.sourceMessageID,
            title: next.title,
            goal: next.goal,
            hostHint: task.hostHint,
            projectHint: task.projectHint,
            status: next.status,
            summary: next.summary,
            currentAction: next.currentAction,
            plan: next.plan,
            timeline: next.timeline,
            pendingApproval: next.pendingApproval,
            changes: next.changes,
            tests: next.tests,
            createdAt: task.createdAt,
            updatedAt: Date()
        )
        replacement.updatedAt = Date()
        upsertAgentTask(replacement)
    }
}
