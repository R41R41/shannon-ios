#if os(macOS)
import AppKit
import Observation
import SwiftUI
import Testing
@testable import ShannonAppCore

@Suite("Task tree in a reused inspector", .serialized)
@MainActor
struct ShannonTaskTreeHostingTests {
    private let firstID = UUID(uuidString: "ABCDEF01-2345-6789-ABCD-EF0123456789")!
    private let secondID = UUID(uuidString: "ABCDEF02-2345-6789-ABCD-EF0123456789")!

    @Test func taskSwitchLoadsTheNewCachedModelAndReloadsWhenReturning() async throws {
        let client = HostedTaskTreeClient()
        let conversation = ShannonConversationModel(scopeKey: "synthetic-hosting", client: client, usesDisplayCache: false)
        let selection = HostedTaskSelection(firstID)
        let host = TaskTreeHostingWindow(selection: selection, conversation: conversation)
        defer { host.close() }
        let first = conversation.taskTreeModel(for: firstID)
        let second = conversation.taskTreeModel(for: secondID)
        try #require(await wait { selection.mounted })
        try #require(await wait { first.fresh })
        #expect(await client.treeReads(first.taskID) == 1)
        selection.taskID = secondID
        #expect(await wait { second.fresh })
        #expect(await client.treeReads(second.taskID) == 1)
        #expect(await client.proposalReads(second.taskID) == 1)
        #expect(second.read?.tree.taskId == second.taskID)
        #expect(first !== second)
        selection.taskID = firstID
        #expect(await wait { await client.treeReads(first.taskID) == 2 })
        #expect(conversation.taskTreeModel(for: firstID) === first)
        #expect(first.read?.tree.taskId == first.taskID)
    }

    @Test func switchingPreservesUnknownOriginalApprovalAndRecoversItWithGetOnly() async throws {
        let client = HostedTaskTreeClient()
        let conversation = ShannonConversationModel(scopeKey: "synthetic-hosting", client: client, usesDisplayCache: false)
        let selection = HostedTaskSelection(firstID)
        let host = TaskTreeHostingWindow(selection: selection, conversation: conversation)
        defer { host.close() }
        let first = conversation.taskTreeModel(for: firstID)
        let second = conversation.taskTreeModel(for: secondID)
        try #require(await wait { first.fresh })
        var change = ShannonTaskTreeChangeDTO(tree: try #require(first.read?.tree))
        change.goal = "採用された合成の目的"
        await first.propose(change)
        let proposal = try #require(first.proposals.first)
        await client.loseNextApprovalReply()
        await first.approve(proposal)
        let pending = try #require(first.pending)
        #expect(!first.isAdoptionConfirmed(proposal))
        selection.taskID = secondID
        try #require(await wait { second.fresh })
        #expect(conversation.taskTreeModel(for: firstID) === first)
        #expect(first.pending == pending)
        #expect(second.pending == nil && !second.isAdoptionConfirmed(proposal))
        await client.restoreReads(first.taskID)
        selection.taskID = firstID
        try #require(await wait { first.pending == nil && first.isAdoptionConfirmed(proposal) })
        #expect(first.read?.tree.goal == change.goal)
        #expect(await client.proposalPosts == 1)
        #expect(await client.approvalPosts == 1)
    }

    @Test func audienceChangeHidesTheSwitchedTaskAndFencesItsLateRead() async throws {
        let client = HostedTaskTreeClient()
        let conversation = ShannonConversationModel(scopeKey: "synthetic-hosting", client: client, usesDisplayCache: false)
        let selection = HostedTaskSelection(firstID)
        let host = TaskTreeHostingWindow(selection: selection, conversation: conversation)
        defer { host.close() }
        let first = conversation.taskTreeModel(for: firstID)
        let second = conversation.taskTreeModel(for: secondID)
        try #require(await wait { first.fresh })
        await client.holdNextRead(second.taskID)
        selection.taskID = secondID
        try #require(await wait { await client.hasHeldRead(second.taskID) })
        conversation.setStage5Audience(othersPresent: true)
        await client.finishHeldRead(second.taskID)
        try #require(await wait { await client.proposalReads(second.taskID) == 1 })
        #expect(second.hidden && second.read == nil && second.proposals.isEmpty && !second.fresh)
        #expect(first.hidden && first.read == nil)
        conversation.setStage5Audience(othersPresent: false)
        try #require(await wait { second.fresh })
        #expect(await client.treeReads(second.taskID) == 2)
        #expect(second.read?.tree.taskId == second.taskID)
        #expect(conversation.taskTreeModel(for: secondID) === second)
        #expect(await client.proposalPosts == 0)
        #expect(await client.approvalPosts == 0)
    }

    private func wait(_ condition: @MainActor () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if await condition() { return true }
            pumpMainRunLoop()
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await condition()
    }
    private func pumpMainRunLoop() { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
}

@MainActor @Observable
private final class HostedTaskSelection {
    var taskID: UUID
    var mounted = false
    init(_ taskID: UUID) { self.taskID = taskID }
}

@MainActor
private struct HostedTaskInspector: View {
    @Bindable var selection: HostedTaskSelection
    let conversation: ShannonConversationModel
    var body: some View {
        VStack {
            Text("合成の仕事インスペクタ")
            ShannonTaskTreeView(model: conversation.taskTreeModel(for: selection.taskID))
        }
        .task { selection.mounted = true }
    }
}

@MainActor
private final class TaskTreeHostingWindow {
    private let window: NSWindow
    init(selection: HostedTaskSelection, conversation: ShannonConversationModel) {
        let size = CGSize(width: 560, height: 640)
        let hosting = NSHostingView(rootView: HostedTaskInspector(selection: selection, conversation: conversation))
        hosting.sizingOptions = []
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        hosting.frame = CGRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
    }
    func close() { window.contentView = nil; window.close() }
}

private actor HostedTaskTreeClient: ShannonAPIClientProtocol, ShannonTaskTreeServing {
    private var reads: [String: Int] = [:]
    private var proposalReadCounts: [String: Int] = [:]
    private var trees: [String: ShannonTaskTreeDTO] = [:]
    private var proposals: [String: [ShannonTaskTreeProposalDTO]] = [:]
    private var unreadable: Set<String> = []
    private var heldIDs: Set<String> = []
    private var held: [String: CheckedContinuation<ShannonTaskTreeReadDTO, Never>] = [:]
    private var losesApproval = false
    private(set) var proposalPosts = 0
    private(set) var approvalPosts = 0
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO { throw ShannonAPIError.invalidResponse }
    func treeReads(_ id: String) -> Int { reads[id, default: 0] }
    func proposalReads(_ id: String) -> Int { proposalReadCounts[id, default: 0] }
    func loseNextApprovalReply() { losesApproval = true }
    func restoreReads(_ id: String) { unreadable.remove(id) }
    func holdNextRead(_ id: String) { heldIDs.insert(id) }
    func hasHeldRead(_ id: String) -> Bool { held[id] != nil }
    func finishHeldRead(_ id: String) {
        held.removeValue(forKey: id)?.resume(returning: ShannonTaskTreeReadDTO(tree: tree(id), verification: nil))
    }
    func loadTaskTree(scopeKey: String, taskID: String) async throws -> ShannonTaskTreeReadDTO {
        reads[taskID, default: 0] += 1
        if unreadable.contains(taskID) { throw ShannonAPIError.rejected(status: 503) }
        if heldIDs.remove(taskID) != nil { return await withCheckedContinuation { held[taskID] = $0 } }
        return ShannonTaskTreeReadDTO(tree: tree(taskID), verification: nil)
    }
    func loadTaskTreeProposals(scopeKey: String, taskID: String) async throws -> [ShannonTaskTreeProposalDTO] {
        proposalReadCounts[taskID, default: 0] += 1
        return proposals[taskID, default: []]
    }
    func proposeTaskTree(scopeKey: String, taskID: String, revision: Int, change: ShannonTaskTreeChangeDTO, operationID: String) async throws -> ShannonTaskTreeProposalDTO {
        proposalPosts += 1
        let proposal = ShannonTaskTreeProposalDTO(id: "original-proposal", taskId: taskID, expectedRevision: revision,
            diffHash: "original-diff", change: change, state: "proposed", operationId: operationID)
        proposals[taskID] = [proposal]
        return proposal
    }
    func approveTaskTree(scopeKey: String, proposal: ShannonTaskTreeProposalDTO) async throws -> ShannonTaskTreeDTO {
        approvalPosts += 1
        let original = tree(proposal.taskId)
        let updated = ShannonTaskTreeDTO(schema: original.schema, taskId: original.taskId, revision: original.revision + 1,
            rootId: original.rootId, goal: proposal.change.goal, content: proposal.change.content, deadline: proposal.change.deadline,
            origin: original.origin, legacy: false, nodes: original.nodes)
        trees[proposal.taskId] = updated
        proposals[proposal.taskId] = [.init(id: proposal.id, taskId: proposal.taskId, expectedRevision: proposal.expectedRevision,
            diffHash: proposal.diffHash, change: proposal.change, state: "approved", operationId: proposal.operationId)]
        if losesApproval {
            losesApproval = false; unreadable.insert(proposal.taskId)
            throw URLError(.networkConnectionLost)
        }
        return updated
    }
    private func tree(_ id: String) -> ShannonTaskTreeDTO {
        trees[id] ?? ShannonTaskTreeDTO(schema: "shannon.task-tree.v1", taskId: id, revision: 1, rootId: "root:\(id)",
            goal: "合成タスクの目的", content: "実データを使わない表示の確認", deadline: nil, origin: "owner_request", legacy: false, nodes: [])
    }
}
#endif
