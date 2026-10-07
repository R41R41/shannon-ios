import Foundation
import Observation

public struct ShannonTaskFinishContractDTO: Codable, Equatable, Sendable {
    public var result: String
    public var checks: [Check]
    public var constraints: [String]
    public var boundary: [String]
    public var stop: [String]
    public struct Check: Codable, Identifiable, Equatable, Sendable {
        public let id: String
        public let kind: String
        public var target: String
    }
}
public struct ShannonTaskTreeNodeDTO: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var parentId: String?
    public var order: Int
    public var dependsOn: [String]
    public var title: String
    public var contract: ShannonTaskFinishContractDTO?
    public let state: String
    public let attemptId: String?
}
public struct ShannonTaskTreeDTO: Codable, Equatable, Sendable {
    public let schema: String
    public let taskId: String
    public let revision: Int
    public let rootId: String
    public let goal: String
    public let content: String
    public let deadline: String?
    public let origin: String
    public let legacy: Bool
    public let nodes: [ShannonTaskTreeNodeDTO]
}
public struct ShannonTaskTreeReadDTO: Codable, Sendable {
    public let tree: ShannonTaskTreeDTO
    public let verification: Verification?
    public struct Verification: Codable, Sendable { public let status: String; public let evidenceIds: [String]? }
}
public struct ShannonTaskTreeChangeDTO: Codable, Equatable, Sendable {
    public var goal: String
    public var content: String
    public var deadline: String?
    public var nodes: [Node]
    public struct Node: Codable, Identifiable, Equatable, Sendable {
        public let id: String
        public var parentId: String?
        public var order: Int
        public var dependsOn: [String]
        public var title: String
        public var contract: ShannonTaskFinishContractDTO?
    }
    init(tree: ShannonTaskTreeDTO) {
        goal = tree.goal; content = tree.content; deadline = tree.deadline
        nodes = tree.nodes.map { Node(id: $0.id, parentId: $0.parentId, order: $0.order,
            dependsOn: $0.dependsOn, title: $0.title, contract: $0.contract) }
    }
}
public struct ShannonTaskTreeProposalDTO: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let taskId: String
    public let expectedRevision: Int
    public let diffHash: String
    public let change: ShannonTaskTreeChangeDTO
    public let state: String
    public var operationId: String? = nil
}
public protocol ShannonTaskTreeServing: Sendable {
    func loadTaskTree(scopeKey: String, taskID: String) async throws -> ShannonTaskTreeReadDTO
    func loadTaskTreeProposals(scopeKey: String, taskID: String) async throws -> [ShannonTaskTreeProposalDTO]
    func proposeTaskTree(scopeKey: String, taskID: String, revision: Int, change: ShannonTaskTreeChangeDTO, operationID: String) async throws -> ShannonTaskTreeProposalDTO
    func approveTaskTree(scopeKey: String, proposal: ShannonTaskTreeProposalDTO) async throws -> ShannonTaskTreeDTO
}

@MainActor @Observable
public final class ShannonTaskTreeModel {
    public private(set) var read: ShannonTaskTreeReadDTO?
    public private(set) var proposals: [ShannonTaskTreeProposalDTO] = []
    public private(set) var notice: String?
    public private(set) var isLoading = false
    public private(set) var hidden = false
    public private(set) var othersPresent = false
    public private(set) var fresh = false
    public private(set) var pending: Pending?
    let taskID: String
    private let scopeKey: String
    private let client: (any ShannonTaskTreeServing)?
    private var generation = 0
    public enum Pending: Equatable, Sendable { case proposal(operationID: String); case approval(id: String, diffHash: String) }
    public init(scopeKey: String, taskID: String, client: (any ShannonTaskTreeServing)?) {
        self.scopeKey = scopeKey; self.taskID = taskID; self.client = client
    }
    public func setAudience(othersPresent: Bool) {
        guard self.othersPresent != othersPresent else { return }
        generation += 1; self.othersPresent = othersPresent; hidden = othersPresent
        read = nil; proposals = []; fresh = false; notice = nil; isLoading = false
    }
    public func reload() async {
        guard let client, !othersPresent else { hidden = true; return }
        generation += 1; let epoch = generation
        isLoading = true; fresh = false
        defer { if epoch == generation { isLoading = false } }
        do {
            let result = try await client.loadTaskTree(scopeKey: scopeKey, taskID: taskID)
            let proposalList = try await client.loadTaskTreeProposals(scopeKey: scopeKey, taskID: taskID)
            guard result.tree.taskId == taskID, proposalList.allSatisfy({ $0.taskId == taskID }) else { throw ShannonAPIError.invalidResponse }
            // Receipt resolution survives a newer read overtaking this GET. Display does not.
            if let pending {
                let acknowledged = switch pending {
                case .proposal(let id): proposalList.contains { $0.operationId == id }
                case .approval(let id, let hash): proposalList.contains { $0.id == id && $0.diffHash == hash && $0.state == "approved" }
                }
                if acknowledged, self.pending == pending { self.pending = nil; notice = nil }
            }
            guard epoch == generation else { return }
            if result.tree.revision >= (read?.tree.revision ?? -1) { read = result; proposals = proposalList }
            fresh = true; hidden = false
            notice = pending == nil ? nil : "届いたか確かめています…"
        } catch {
            guard epoch == generation else { return }
            hidden = ShannonFeedbackModel.hidden(error)
            if hidden { read = nil; proposals = [] }
            notice = pending == nil ? "作業の条件を読み込めません。接続後に読み直してください。" : "届いたか確認できません。接続後に確認してください。"
        }
    }
    public func propose(_ change: ShannonTaskTreeChangeDTO) async {
        guard let client, let tree = read?.tree, fresh, pending == nil, !hidden else { return }
        let id = UUID().uuidString; pending = .proposal(operationID: id)
        do {
            let value = try await client.proposeTaskTree(scopeKey: scopeKey, taskID: taskID,
                revision: tree.revision, change: change, operationID: id)
            guard value.taskId == taskID, value.expectedRevision == tree.revision, value.change == change else { throw ShannonAPIError.invalidResponse }
            if case .proposal(let current) = pending, current == id { pending = nil }
            await reload()
        } catch { await handle(error, expected: .proposal(operationID: id)) }
    }
    public func approve(_ proposal: ShannonTaskTreeProposalDTO) async {
        guard let client, fresh, pending == nil, proposal.state == "proposed",
              read?.tree.revision == proposal.expectedRevision else { return }
        pending = .approval(id: proposal.id, diffHash: proposal.diffHash)
        do {
            let value = try await client.approveTaskTree(scopeKey: scopeKey, proposal: proposal)
            guard value.taskId == taskID, value.revision > proposal.expectedRevision else { throw ShannonAPIError.invalidResponse }
            if case .approval(let id, let hash) = pending, id == proposal.id && hash == proposal.diffHash { pending = nil }
            await reload()
        } catch { await handle(error, expected: .approval(id: proposal.id, diffHash: proposal.diffHash)) }
    }
    private func handle(_ error: any Error, expected: Pending) async {
        guard pending == expected else { return }
        if ShannonFeedbackModel.definiteRefusal(error) { pending = nil; await reload(); notice = "変更されませんでした。最新の条件を表示しています。" }
        else { notice = "届いたか確かめています…"; await reload() }
    }
}

extension ShannonConversationModel {
    public func taskTreeModel(for id: UUID) -> ShannonTaskTreeModel {
        if let existing = taskTreeModels[id] { return existing }
        let model = ShannonTaskTreeModel(scopeKey: scopeKey, taskID: id.uuidString.lowercased(), client: client as? any ShannonTaskTreeServing)
        model.setAudience(othersPresent: stage5OthersPresent)
        taskTreeModels[id] = model
        return model
    }
}
