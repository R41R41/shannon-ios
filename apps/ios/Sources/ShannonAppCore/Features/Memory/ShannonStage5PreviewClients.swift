#if DEBUG
import Foundation

/// Harness transports exercise the real models; all receipts and competing writes are synthetic, in-memory state.
actor Stage5PreviewFeedback: ShannonFeedbackServing {
    private let scenario: ShannonStage5Preview.Scenario
    private var current: ShannonFeedbackDTO
    private var operations: [String: ShannonFeedbackDTO] = [:]
    private struct Request: Equatable { let target: ShannonFeedbackDTO; let reaction: ShannonFeedbackReaction? }
    private var requests: [String: Request] = [:]
    private var failedReads = 0
    private var injected = false
    private(set) var posts = 0
    init(target: ShannonFeedbackDTO, scenario: ShannonStage5Preview.Scenario = .normal) {
        current = target; self.scenario = scenario
    }
    func currentTarget() -> ShannonFeedbackDTO { current }
    func loadFeedback(scopeKey: String, target: ShannonFeedbackDTO, operationID: String?) async throws -> ShannonFeedbackReadDTO {
        if failedReads > 0 { failedReads -= 1; throw URLError(.notConnectedToInternet) }
        return ShannonFeedbackReadDTO(feedback: current, operation: operationID.flatMap { operations[$0] })
    }
    func changeFeedback(scopeKey: String, target: ShannonFeedbackDTO, reaction: ShannonFeedbackReaction?, operationID: String) async throws -> ShannonFeedbackDTO {
        posts += 1
        let request = Request(target: target, reaction: reaction)
        if let receipt = operations[operationID] {
            guard requests[operationID] == request else { throw ShannonAPIError.rejected(status: 409) }
            return receipt
        }
        if scenario == .conflict, !injected {
            injected = true
            current = value(reaction: .bad, operationID: "synthetic-other-device")
            throw ShannonAPIError.rejected(status: 409)
        }
        guard current.revision == target.revision else { throw ShannonAPIError.rejected(status: 409) }
        current = value(reaction: reaction, operationID: operationID)
        operations[operationID] = current; requests[operationID] = request
        if (scenario == .unknown || scenario == .offline), !injected {
            injected = true; failedReads = 1
            throw URLError(.networkConnectionLost)
        }
        return current
    }
    private func value(reaction: ShannonFeedbackReaction?, operationID: String) -> ShannonFeedbackDTO {
        ShannonFeedbackDTO(targetId: current.targetId, threadId: current.threadId, turnId: current.turnId,
            revision: current.revision + 1, reaction: reaction, operationId: operationID)
    }
}

actor Stage5PreviewInterests: ShannonInterestsServing {
    private let scenario: ShannonStage5Preview.Scenario
    private var revision = 1
    private var pinned = false
    private var banned = false
    private var frozen = false
    private var forgotten = false
    private var undone = false
    private var journal: [ShannonInterestChangeDTO] = []
    private var operations: [String: ShannonInterestMutationDTO] = [:]
    private struct Request: Equatable { let item: ShannonInterestDTO; let action: ShannonInterestAction; let changeID: String? }
    private var requests: [String: Request] = [:]
    private var initialRead = true
    private var injected = false
    private var failedOperationReads = 0
    private(set) var posts = 0
    init(scenario: ShannonStage5Preview.Scenario = .normal) { self.scenario = scenario }
    private var item: ShannonInterestDTO {
        makeItem(revision: revision, description: undone ? "星と星座を知る" : "星と星座を知り、観察の方法も試す",
            pinned: pinned, banned: banned, frozen: frozen)
    }
    private func makeItem(revision: Int, description: String, pinned: Bool = false, banned: Bool = false, frozen: Bool = false) -> ShannonInterestDTO {
        ShannonInterestDTO(id: "synthetic-interest", title: "夜空を観察する", description: description,
            reason: "最近、星の見え方や観察する道具について話したため。", weight: 0.6,
            evidenceRefs: ["synthetic-evidence"], revision: revision, pinned: pinned, banned: banned,
            forgotten: false, frozen: frozen, retired: false, createdAt: "2026-10-07T22:00:00Z", updatedAt: "2026-10-08T00:00:00Z")
    }
    private func project(_ value: ShannonInterestDTO) -> ShannonInterestDTO {
        guard forgotten else { return value }
        return ShannonInterestDTO(id: value.id, title: "（表示しない関心）", description: "", reason: "",
            weight: nil, evidenceRefs: [], revision: value.revision, pinned: value.pinned, banned: value.banned,
            forgotten: true, frozen: value.frozen, retired: value.retired, createdAt: value.createdAt, updatedAt: value.updatedAt)
    }
    private var changes: [ShannonInterestChangeDTO] {
        let before = makeItem(revision: 0, description: "星と星座を知る")
        let after = makeItem(revision: 1, description: "星と星座を知り、観察の方法も試す")
        let original = ShannonInterestChangeDTO(changeId: "synthetic-change", seq: 1, itemId: item.id, actor: "sleep", kind: "patch",
            reason: after.reason, before: before, after: after, nightKey: "2026-10-07", createdAt: "2026-10-07T22:00:00Z")
        return ([original] + journal).map { change in
            ShannonInterestChangeDTO(changeId: change.changeId, seq: change.seq, itemId: change.itemId, actor: change.actor,
                kind: change.kind, reason: forgotten ? "（表示しない変更）" : change.reason,
                before: change.before.map { project($0) }, after: project(change.after), nightKey: change.nightKey, createdAt: change.createdAt)
        }.sorted { $0.seq > $1.seq }
    }
    private var snapshot: ShannonInterestsDTO {
        let visible = project(item)
        return ShannonInterestsDTO(revision: revision, items: scenario == .empty ? [] : [visible], changes: scenario == .empty ? [] : changes,
            capacity: .init(used: scenario == .empty || !visible.active ? 0 : 1, limit: 12), nextCursor: nil)
    }
    func loadInterests(scopeKey: String, cursor: Int?) async throws -> ShannonInterestsDTO {
        if initialRead {
            initialRead = false
            if scenario == .offline { throw URLError(.notConnectedToInternet) }
            if scenario == .loading { try await Task.sleep(for: .seconds(5)) }
        }
        return snapshot
    }
    func loadInterest(scopeKey: String, id: String, cursor: Int?) async throws -> ShannonInterestDetailDTO {
        guard id == item.id, scenario != .empty else { throw ShannonAPIError.rejected(status: 404) }
        let evidence = ShannonInterestDetailDTO.Evidence(status: forgotten ? "hidden" : "available", total: forgotten ? 0 : 1,
            items: forgotten ? [] : [.init(id: "synthetic-evidence", text: "週末、暗い場所で星を見たい。観察するときの道具も知りたい。", truncated: false)], omitted: 0)
        return ShannonInterestDetailDTO(revision: revision, item: project(item), changes: changes, nextCursor: nil, evidence: evidence)
    }
    func changeInterest(scopeKey: String, item: ShannonInterestDTO, action: ShannonInterestAction, changeID: String?, operationID: String) async throws -> ShannonInterestMutationDTO {
        posts += 1
        let request = Request(item: item, action: action, changeID: changeID)
        if let existing = operations[operationID] {
            guard requests[operationID] == request else { throw ShannonAPIError.rejected(status: 409) }
            return receipt(existing)
        }
        if scenario == .conflict, !injected {
            injected = true; let before = self.item; pinned = true; revision += 1
            appendChange(before: before, action: .pin, reason: "別の端末で固定しました（合成）。")
            throw ShannonAPIError.rejected(status: 409)
        }
        guard item.id == self.item.id, revision == item.revision, !forgotten else { throw ShannonAPIError.rejected(status: 409) }
        let before = self.item
        switch action {
        case .undo:
            guard changeID == "synthetic-change" else { throw ShannonAPIError.rejected(status: 409) }
            undone = true; frozen = true
        case .pin: pinned = true
        case .unpin: pinned = false
        case .ban: banned = true
        case .unban: banned = false
        case .forget: forgotten = true
        case .resume: frozen = false
        }
        revision += 1
        appendChange(before: before, action: action, reason: action == .undo ? "この変更を戻し、自動更新を止めました。" : "あなたの操作で扱いを変更しました。")
        let result = ShannonInterestMutationDTO(code: "changed", item: self.item, revision: revision)
        operations[operationID] = result; requests[operationID] = request
        if scenario == .unknown, !injected {
            injected = true; failedOperationReads = 1
            throw URLError(.networkConnectionLost)
        }
        return receipt(result)
    }
    func loadInterestOperation(scopeKey: String, operationID: String) async throws -> ShannonInterestOperationDTO {
        if failedOperationReads > 0 { failedOperationReads -= 1; throw URLError(.notConnectedToInternet) }
        return ShannonInterestOperationDTO(operationId: operationID, found: operations[operationID] != nil,
            result: operations[operationID].map { receipt($0) }, latest: snapshot)
    }
    private func receipt(_ value: ShannonInterestMutationDTO) -> ShannonInterestMutationDTO {
        ShannonInterestMutationDTO(code: value.code, item: value.item.map { project($0) }, revision: value.revision)
    }
    private func appendChange(before: ShannonInterestDTO, action: ShannonInterestAction, reason: String) {
        journal.append(ShannonInterestChangeDTO(changeId: "synthetic-owner-\(revision)", seq: revision, itemId: item.id, actor: "owner",
            kind: action.rawValue, reason: reason, before: before, after: item, nightKey: nil, createdAt: "2026-10-08T00:00:00Z"))
    }
}

actor Stage5PreviewTask: ShannonTaskTreeServing {
    private let scenario: ShannonStage5Preview.Scenario
    private var revision = 1
    private var proposals: [ShannonTaskTreeProposalDTO] = []
    private var adopted: ShannonTaskTreeChangeDTO?
    private var initialRead = true
    private var injectedConflict = false
    private var lostProposal = false
    private var lostApproval = false
    private var failedProposalReads = 0
    private(set) var proposalPosts = 0
    private(set) var approvalPosts = 0
    init(scenario: ShannonStage5Preview.Scenario = .normal) { self.scenario = scenario }
    private var contract: ShannonTaskFinishContractDTO {
        .init(result: "既存の本文を保った一覧ができる", checks: [.init(id: "synthetic-check", kind: "test", target: "記事の件数と本文が元の記録と一致する")],
            constraints: ["本文を書き換えない"], boundary: ["選んだ記事だけ"], stop: ["記事を確認できない場合は止める"])
    }
    private var tree: ShannonTaskTreeDTO {
        if let adopted {
            return ShannonTaskTreeDTO(schema: "shannon.task-tree.v1", taskId: "synthetic-task", revision: revision, rootId: "synthetic-root",
                goal: adopted.goal, content: adopted.content, deadline: adopted.deadline, origin: "owner_request", legacy: false,
                nodes: adopted.nodes.map { .init(id: $0.id, parentId: $0.parentId, order: $0.order, dependsOn: $0.dependsOn,
                    title: $0.title, contract: $0.contract, state: "wait", attemptId: nil) })
        }
        let root = ShannonTaskTreeNodeDTO(id: "synthetic-root", parentId: nil, order: 0, dependsOn: [], title: "読みものを整理する",
            contract: scenario == .empty ? nil : contract, state: "wait", attemptId: nil)
        let children: [ShannonTaskTreeNodeDTO] = scenario == .empty ? [] : [
            .init(id: "synthetic-first", parentId: root.id, order: 0, dependsOn: [], title: "記事を確認する", contract: contract, state: "done", attemptId: nil),
            .init(id: "synthetic-second", parentId: root.id, order: 1, dependsOn: ["synthetic-first"], title: "分類した一覧を作る", contract: contract, state: "continue", attemptId: nil)]
        return ShannonTaskTreeDTO(schema: "shannon.task-tree.v1", taskId: "synthetic-task", revision: revision, rootId: root.id,
            goal: "読みものを整理する", content: "保存した記事を分類し、探しやすい一覧にする", deadline: nil,
            origin: "owner_request", legacy: false, nodes: [root] + children)
    }
    func loadTaskTree(scopeKey: String, taskID: String) async throws -> ShannonTaskTreeReadDTO {
        if initialRead {
            initialRead = false
            if scenario == .offline { throw URLError(.notConnectedToInternet) }
            if scenario == .loading { try await Task.sleep(for: .seconds(5)) }
        }
        return ShannonTaskTreeReadDTO(tree: tree, verification: .init(status: "invalid", evidenceIds: nil))
    }
    func loadTaskTreeProposals(scopeKey: String, taskID: String) async throws -> [ShannonTaskTreeProposalDTO] {
        if failedProposalReads > 0 { failedProposalReads -= 1; throw URLError(.notConnectedToInternet) }
        return proposals
    }
    func proposeTaskTree(scopeKey: String, taskID: String, revision: Int, change: ShannonTaskTreeChangeDTO, operationID: String) async throws -> ShannonTaskTreeProposalDTO {
        proposalPosts += 1
        if let previous = proposals.first(where: { $0.operationId == operationID }) {
            guard previous.expectedRevision == revision, previous.change == change else { throw ShannonAPIError.rejected(status: 409) }
            return previous
        }
        if scenario == .conflict, !injectedConflict {
            injectedConflict = true; self.revision += 1
            throw ShannonAPIError.rejected(status: 409)
        }
        guard revision == self.revision else { throw ShannonAPIError.rejected(status: 409) }
        let value = ShannonTaskTreeProposalDTO(id: UUID().uuidString, taskId: taskID, expectedRevision: revision,
            diffHash: "synthetic-diff", change: change, state: "proposed", operationId: operationID)
        proposals.append(value)
        if scenario == .unknown, !lostProposal {
            lostProposal = true; failedProposalReads = 1; throw URLError(.networkConnectionLost)
        }
        return value
    }
    func approveTaskTree(scopeKey: String, proposal: ShannonTaskTreeProposalDTO) async throws -> ShannonTaskTreeDTO {
        approvalPosts += 1
        guard let saved = proposals.first(where: { $0.id == proposal.id }), saved.diffHash == proposal.diffHash, saved.taskId == proposal.taskId,
            saved.expectedRevision == proposal.expectedRevision, saved.change == proposal.change else { throw ShannonAPIError.rejected(status: 409) }
        if saved.state == "approved" { return tree }
        guard revision == saved.expectedRevision else { throw ShannonAPIError.rejected(status: 409) }
        revision += 1; adopted = saved.change
        proposals = proposals.map { $0.id == saved.id ? .init(id: $0.id, taskId: $0.taskId,
            expectedRevision: $0.expectedRevision, diffHash: $0.diffHash, change: $0.change, state: "approved", operationId: $0.operationId) : $0 }
        if scenario == .unknown, !lostApproval {
            lostApproval = true; failedProposalReads = 1; throw URLError(.networkConnectionLost)
        }
        return tree
    }
}
#endif
