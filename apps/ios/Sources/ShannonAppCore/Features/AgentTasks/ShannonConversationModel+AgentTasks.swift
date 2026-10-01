import Foundation
import Observation

extension ShannonConversationModel {
    @discardableResult
    public func proposeAppleRelease(_ target: ShannonAppleReleaseTarget) -> UUID {
        let task = ShannonAppleReleaseTaskFactory.make(
            target: target,
            threadID: selectedThreadId ?? "local-release",
            sourceMessageID: messages.last(where: { $0.role == .shannon })?.id
        )
        upsertAgentTask(task)
        return task.id
    }

    public func provisionAgentProject(
        repositoryURL: String,
        projectKey: String,
        hostPreference: ShannonAgentRoutingPreference
    ) async -> Bool {
        guard !isDesignPreview, !isProvisioningAgentProject else { return false }
        isProvisioningAgentProject = true
        agentProjectProvisioningError = nil
        defer { isProvisioningAgentProject = false }
        do {
            let createdRequests = try await client.createAgentProjectProvisioning(
                scopeKey: scopeKey,
                repositoryURL: repositoryURL,
                projectKey: projectKey,
                hostPreference: hostPreference,
                idempotencyKey: "project-\(UUID().uuidString.lowercased())"
            )
            for request in createdRequests { upsertProjectProvisioning(request) }
            let requestIDs = Set(createdRequests.map(\.id))
            for _ in 0..<200 {
                if Task.isCancelled { return false }
                let currentRequests = agentProjectProvisioning.filter { requestIDs.contains($0.id) }
                if currentRequests.contains(where: { $0.status == .ready }) {
                    await refreshAgentWorkspace(projectHint: projectKey)
                    return true
                }
                if currentRequests.count == requestIDs.count,
                   currentRequests.allSatisfy(\.status.isTerminal) {
                    agentProjectProvisioningError = currentRequests
                        .compactMap(\.errorMessage)
                        .first ?? "リポジトリを追加できませんでした。"
                    return false
                }
                try await Task.sleep(for: .seconds(1.5))
                let requests = try await client.loadAgentProjectProvisioning(scopeKey: scopeKey)
                agentProjectProvisioning = requests
            }
            if agentProjectProvisioning.contains(where: {
                requestIDs.contains($0.id) && $0.status == .ready
            }) {
                await refreshAgentWorkspace(projectHint: projectKey)
                return true
            }
            agentProjectProvisioningError = "リポジトリの取得が続いています。更新ボタンで状態を確認できます。"
            return false
        } catch {
            agentProjectProvisioningError = "リポジトリを追加できませんでした。URL、実行先、GitHub権限を確認してください。"
            return false
        }
    }

    public func refreshAgentProjectProvisioning() async {
        guard !isDesignPreview else { return }
        do {
            agentProjectProvisioning = try await client.loadAgentProjectProvisioning(scopeKey: scopeKey)
        } catch {
            // Workspace remains usable while provisioning status is temporarily unavailable.
        }
    }

    private func upsertProjectProvisioning(_ request: ShannonAgentProjectProvisioningDTO) {
        agentProjectProvisioning.removeAll { $0.id == request.id }
        agentProjectProvisioning.insert(request, at: 0)
    }

    public func refreshAgentWorkspace(projectHint: String? = nil) async {
        guard !isDesignPreview else { return }
        isLoadingAgentWorkspace = true
        defer { isLoadingAgentWorkspace = false }
        do {
            agentWorkspace = try await client.loadAgentWorkspace(scopeKey: scopeKey, projectHint: projectHint)
            agentWorkspaceError = nil
        } catch {
            agentWorkspaceError = "作業環境の状態を取得できませんでした。"
        }
    }

    public func loadAgentWorkspaceResource(
        projectKey: String,
        path: String,
        kind: ShannonAgentWorkspaceResourceKind,
        hostPreference: ShannonAgentRoutingPreference
    ) async throws -> ShannonAgentWorkspaceResourceDTO {
        if isDesignPreview {
            return ShannonAgentWorkspaceResourceDTO(
                id: "preview-resource",
                projectKey: projectKey,
                path: path,
                kind: kind,
                assignedHostID: "preview-local",
                status: .ready,
                content: kind == .diff ? "+let preview = true" : "import SwiftUI\n\nstruct PreviewView: View {}",
                truncated: false,
                errorCode: nil,
                errorMessage: nil,
                createdAt: "2026-09-15T12:00:00Z",
                updatedAt: "2026-09-15T12:00:00Z"
            )
        }
        return try await client.loadAgentWorkspaceResource(
            scopeKey: scopeKey,
            projectKey: projectKey,
            path: path,
            kind: kind,
            hostPreference: hostPreference
        )
    }

    public func configureAgentTask(
        _ id: UUID,
        hostPreference: ShannonAgentRoutingPreference,
        projectHint: String?,
        model: String?,
        reasoningEffort: ShannonAgentReasoningEffort?
    ) {
        guard var task = agentTask(id: id), task.status == .proposed else { return }
        task.hostHint = hostPreference.rawValue
        task.projectHint = projectHint?.trimmingCharacters(in: .whitespacesAndNewlines)
        task.model = model?.trimmingCharacters(in: .whitespacesAndNewlines)
        task.reasoningEffort = reasoningEffort
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

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
                errorMessage = ShannonFailureCopy.agentTaskStart(error)
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
            // The owner stopped it here, so the cancellation is not news to them.
            if agentTask(id: id)?.status == .cancelled { acknowledgeAgentTask(id) }
            return
        }
        task.status = .cancelled
        task.summary = "この作業は始めないことにした。"
        task.currentAction = nil
        task.pendingApproval = nil
        task.updatedAt = Date()
        upsertAgentTask(task)
        acknowledgeAgentTask(id)
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
        task.pauseReason = target == .paused ? .owner : nil
        task.pauseSequence = nil
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
                    optimistic.summary = accepted ? "許可を送信しています。" : "許可しない判断を送信しています。"
                    optimistic.currentAction = "作業環境へ判断を送信中"
                }
            )
            if !accepted, agentTask(id: id)?.status == .cancelled { acknowledgeAgentTask(id) }
            return
        }
        // Declining stops the task only on a host that cannot decline a single operation.
        let continues = accepted || task.pendingApproval?.denyStopsTask == false
        task.pendingApproval = nil
        task.status = continues ? .running : .cancelled
        task.summary = accepted ? "許可を受け取った。続きから進めるね。"
            : continues ? "この操作は許可されなかった。別の進め方を確認してる。" : "許可されなかったので、作業を中止した。"
        task.currentAction = accepted ? "接続テストを実行中" : continues ? "許可されなかった操作を避けて続行中" : nil
        task.timeline.append(.init(
            sequence: nextAgentSequence(task),
            title: accepted
                ? (forSession ? "ユーザーがこの作業中の操作を許可" : "ユーザーが今回の操作を許可")
                : "ユーザーが操作を許可しなかった",
            tone: accepted ? .progress : .warning
        ))
        task.updatedAt = Date()
        upsertAgentTask(task)
        if task.status == .cancelled { acknowledgeAgentTask(id) }
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
            agentTaskAcknowledgements.prune(keeping: Set(agentTasks.map(\.id)))
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

    /// Records that the owner saw the task's current attention state (a result or a
    /// pause that needs them). A pending approval is not cleared by looking at it:
    /// it stays outstanding until the owner decides it.
    public func acknowledgeAgentTask(_ id: UUID) {
        guard let task = agentTask(id: id), agentTaskAcknowledgements.markSeen(task) else { return }
        agentTaskStore?.saveAcknowledgements(agentTaskAcknowledgements, scopeKey: scopeKey)
    }

    public func toggleAgentTaskPinned(_ id: UUID) async {
        guard var task = agentTask(id: id), !pendingAgentTaskActionIDs.contains(id) else { return }
        let previous = task
        let target = !task.isPinned
        task.updateManagement(isPinned: target)
        task.updatedAt = Date()
        upsertAgentTask(task)
        guard !previewAgentTaskIDs.contains(id) && task.status != .proposed else { return }
        pendingAgentTaskActionIDs.insert(id)
        defer { pendingAgentTaskActionIDs.remove(id) }
        do {
            upsertAgentTask(try await client.updateAgentTaskMetadata(
                scopeKey: scopeKey, taskID: id, isPinned: target, isArchived: nil
            ))
        } catch {
            upsertAgentTask(previous)
            errorMessage = "ピン留めを変更できませんでした。"
        }
    }

    public func setAgentTaskArchived(_ id: UUID, archived: Bool) async {
        guard var task = agentTask(id: id), !pendingAgentTaskActionIDs.contains(id) else { return }
        guard !archived || task.status == .proposed || task.status.isTerminal else {
            errorMessage = "進行中の作業は、完了または中止してからアーカイブできます。"
            return
        }
        let previous = task
        task.updateManagement(isArchived: archived)
        task.updatedAt = Date()
        upsertAgentTask(task)
        guard !previewAgentTaskIDs.contains(id) && task.status != .proposed else { return }
        pendingAgentTaskActionIDs.insert(id)
        defer { pendingAgentTaskActionIDs.remove(id) }
        do {
            upsertAgentTask(try await client.updateAgentTaskMetadata(
                scopeKey: scopeKey, taskID: id, isPinned: nil, isArchived: archived
            ))
        } catch {
            upsertAgentTask(previous)
            errorMessage = archived ? "作業をアーカイブできませんでした。" : "作業を戻せませんでした。"
        }
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
            management: task.management,
            createdAt: task.createdAt,
            updatedAt: Date()
        )
        replacement.updatedAt = Date()
        upsertAgentTask(replacement)
    }
}
