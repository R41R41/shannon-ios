import Foundation
import Testing
@testable import ShannonAppCore

@Suite @MainActor
struct ShannonStage5Tests {
    @Test func optionalTargetsDecodeWithoutChangingOldReplies() throws {
        let old = try JSONDecoder().decode(StoredConversationMessageDTO.self, from: Data("""
        {"id":"message","role":"assistant","content":"返答","observedAt":"2026-10-08T00:00:00Z"}
        """.utf8))
        #expect(old.feedback == nil)
        let request = ShannonRealtimeVoiceTurnRequestDTO(scopeKey: "synthetic", threadId: "thread", userTranscript: "依頼",
            shannonTranscript: "結果", feedbackRecordId: "server-record")
        let encoded = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        #expect(encoded["feedbackRecordId"] as? String == "server-record")
        #expect(encoded["choiceId"] == nil)
    }

    @Test func verifiedTaskReplyKeepsDisplayIdentityAcrossHistoryReads() throws {
        let id = String(repeating: "a", count: 64)
        let message = StoredConversationMessageDTO(id: id, role: "assistant", content: "確認済みの結果",
            observedAt: "2026-10-08T00:00:00Z", sourceExperienceId: "agent-task-result:\(id)")
        let first = try #require(ShannonConversationModel.conversationMessage(message))
        let second = try #require(ShannonConversationModel.conversationMessage(message))
        #expect(first.id == second.id)
        #expect(first.turnID == "agent-task-result:\(id)")
    }

    @Test func voiceFeedbackRemembersTheExactDisplayedPlaceReply() throws {
        let place = ShannonPlaceDTO(name: "[架空]の公園", address: "架空市の広場", reason: "合成確認用",
            mapQuery: "架空の公園", mapUrl: "https://maps.apple.com/?q=synthetic")
        var response = ShannonLiveVoiceDelegationResponseDTO(threadId: "thread", model: "synthetic",
            reply: "書斎を確かめました。", uiBlocks: [ShannonUIBlockDTO(type: "place_search", places: [place])])
        response.feedbackRecordId = "server-record"
        let model = ShannonConversationModel(usesDisplayCache: false)
        model.rememberVoiceFeedback(response, participantMode: .owner)
        let remembered = try #require(model.voiceFeedbackRecords.first)
        #expect(remembered.recordID == "server-record")
        #expect(remembered.reply == "書斎を確かめました。\n\n地図で開く\n- [ 架空 の公園](https://maps.apple.com/?q=synthetic) — 架空市の広場")
        response.companionPresent = true
        model.rememberVoiceFeedback(response, participantMode: .owner)
        #expect(model.voiceFeedbackRecords.count == 1)
    }

    @Test func chooseSwitchAndWithdrawAreOneRevisionEach() async {
        let client = FeedbackFake()
        let model = feedbackModel(client)
        let target = feedback(0)
        await model.choose(.good, target: target)
        #expect(model.state(for: target)?.reaction == .good)
        await model.choose(.bad, target: target)
        #expect(model.state(for: target)?.reaction == .bad)
        await model.choose(.bad, target: target)
        #expect(model.state(for: target)?.reaction == nil)
        #expect(model.state(for: target)?.revision == 3)
        #expect(await client.posts == 3)
    }

    @Test func lostReplyReadsBackReceiptWithoutRetryAndKeepsNewerReaction() async {
        let client = FeedbackFake()
        await client.setLost(superseded: true)
        let model = feedbackModel(client)
        await model.choose(.good, target: feedback(0))
        #expect(model.pending.isEmpty)
        #expect(model.state(for: feedback(0))?.reaction == .bad)
        #expect(model.state(for: feedback(0))?.revision == 2)
        #expect(await client.posts == 1)
    }

    @Test func originalReceiptCanResolvePendingAfterNewerReadWins() async {
        let client = FeedbackFake()
        await client.setLost(superseded: false)
        await client.setHold()
        let model = feedbackModel(client)
        let choose = Task { await model.choose(.good, target: feedback(0)) }
        await client.waitForRead(1)
        let newer = Task { await model.check(feedback(0)) }
        await client.waitForRead(2)
        await client.release(2, value: ShannonFeedbackReadDTO(feedback: feedback(3, reaction: .bad), operation: nil))
        await newer.value
        #expect(!model.pending.isEmpty)
        let original = await client.accepted
        await client.release(1, value: ShannonFeedbackReadDTO(feedback: feedback(1, reaction: .good), operation: original))
        await choose.value
        #expect(model.pending.isEmpty)
        #expect(model.notices.isEmpty)
        #expect(model.state(for: feedback(0))?.revision == 3)
        #expect(model.state(for: feedback(0))?.reaction == .bad)
        #expect(await client.posts == 1)
    }

    @Test func audienceSwitchFencesReadAndDoesNotEraseUnknownWrite() async {
        let client = FeedbackFake()
        await client.setLost(superseded: false)
        await client.setHold()
        let model = feedbackModel(client)
        let choose = Task { await model.choose(.good, target: feedback(0)) }
        await client.waitForRead(1)
        model.setContext(threadID: "thread", othersPresent: true)
        #expect(model.state(for: feedback(0)) == nil)
        let original = await client.accepted
        await client.release(1, value: ShannonFeedbackReadDTO(feedback: feedback(1, reaction: .good), operation: original))
        await choose.value
        #expect(model.targets.isEmpty)
        #expect(model.notices.isEmpty)
        #expect(await client.posts == 1)
    }

    @Test func post403MayHaveAcceptedAndNeverClaimsRefusalOrRetries() async {
        let client = FeedbackFake()
        await client.setConcealed()
        let model = feedbackModel(client)
        await model.choose(.good, target: feedback(0))
        #expect(!model.pending.isEmpty)
        #expect(model.targets.isEmpty)
        #expect(await client.posts == 1)
        await client.setReadable()
        await model.check(feedback(0))
        #expect(model.pending.isEmpty)
        #expect(model.state(for: feedback(0))?.reaction == .good)
        #expect(await client.posts == 1)
    }

    @Test func interestsUnknownReceiptUsesLatestAndDoesNotPostAgain() async throws {
        let client = InterestsFake()
        let model = ShannonInterestsModel(scopeKey: "synthetic", client: client)
        await model.reload()
        let item = try #require(model.snapshot?.items.first)
        await model.perform(item: item, action: .pin)
        #expect(model.pending == nil)
        #expect(model.snapshot?.revision == 3)
        #expect(model.snapshot?.items.first?.pinned == false)
        #expect(await client.posts == 1)
    }

    @Test func rootChangePreservesChildExtraBoundaries() throws {
        let tree = try treeFixture()
        var change = ShannonTaskTreeChangeDTO(tree: tree)
        change.nodes[0].contract?.result = "新しい結果"
        change.nodes[0].contract?.boundary = ["新しい範囲"]
        change.inheritRootChanges(from: tree)
        #expect(change.nodes[1].contract?.result == "新しい結果")
        #expect(change.nodes[1].contract?.boundary == ["子の追加制限", "新しい範囲"])
        #expect(change.nodes[1].contract?.constraints == ["元の制約"])
    }

    @Test func taskProposalAndApprovalUnknownAreReadBackWithoutRetry() async throws {
        let client = try TaskTreeFake()
        let model = ShannonTaskTreeModel(scopeKey: "synthetic", taskID: "task", client: client)
        await model.reload()
        var change = ShannonTaskTreeChangeDTO(tree: try #require(model.read?.tree))
        change.goal = "更新した目的"
        await model.propose(change)
        #expect(model.pending == nil)
        #expect(await client.proposalPosts == 1)
        let proposal = try #require(model.proposals.first)
        await model.approve(proposal)
        #expect(model.pending == nil)
        #expect(model.read?.tree.revision == 3)
        #expect(model.read?.tree.goal == "更新した目的")
        #expect(await client.approvalPosts == 1)
    }

    @Test func knownOthersClearOnlyNewProjectionAndFenceOlderRead() async throws {
        let client = try TaskTreeFake()
        let task = ShannonTaskTreeModel(scopeKey: "synthetic", taskID: "task", client: client)
        await task.reload()
        #expect(task.read != nil)
        await client.holdRead()
        let read = Task { await task.reload() }
        await client.waitForRead()
        task.setAudience(othersPresent: true)
        await client.finishRead()
        await read.value
        #expect(task.read == nil)
        #expect(task.proposals.isEmpty)
        #expect(!task.fresh)
        let interest = ShannonInterestsModel(scopeKey: "synthetic", client: InterestsFake())
        await interest.reload()
        #expect(interest.offered)
        interest.setAudience(othersPresent: true)
        #expect(!interest.offered)
        #expect(interest.snapshot == nil)
    }

    private func feedbackModel(_ client: FeedbackFake) -> ShannonFeedbackModel {
        let model = ShannonFeedbackModel(scopeKey: "synthetic", client: client)
        model.setContext(threadID: "thread", othersPresent: false)
        model.install([feedback(0)], threadID: "thread")
        return model
    }
}

private func feedback(_ revision: Int, reaction: ShannonFeedbackReaction? = nil, operation: String? = nil) -> ShannonFeedbackDTO {
    ShannonFeedbackDTO(targetId: "opaque-target", threadId: "thread", turnId: "turn", revision: revision,
                       reaction: reaction, operationId: operation)
}

private actor FeedbackFake: ShannonFeedbackServing {
    var posts = 0
    var accepted: ShannonFeedbackDTO?
    var current = feedback(0)
    private var lost = false
    private var superseded = false
    private var concealed = false
    private var hold = false
    private var readCount = 0
    private var continuations: [Int: CheckedContinuation<ShannonFeedbackReadDTO, any Error>] = [:]
    private var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    func setLost(superseded: Bool) { lost = true; self.superseded = superseded }
    func setConcealed() { concealed = true }
    func setReadable() { concealed = false }
    func setHold() { hold = true }
    func waitForRead(_ id: Int) async {
        if readCount >= id { return }
        await withCheckedContinuation { waiters[id] = $0 }
    }
    func release(_ id: Int, value: ShannonFeedbackReadDTO) { continuations.removeValue(forKey: id)?.resume(returning: value) }
    func changeFeedback(scopeKey: String, target: ShannonFeedbackDTO, reaction: ShannonFeedbackReaction?, operationID: String) async throws -> ShannonFeedbackDTO {
        posts += 1
        current = feedback(current.revision + 1, reaction: reaction, operation: operationID)
        accepted = current
        if superseded { current = feedback(current.revision + 1, reaction: .bad, operation: "other-device") }
        if concealed { throw ShannonAPIError.rejected(status: 403) }
        if lost { throw URLError(.networkConnectionLost) }
        return current
    }
    func loadFeedback(scopeKey: String, target: ShannonFeedbackDTO, operationID: String?) async throws -> ShannonFeedbackReadDTO {
        readCount += 1
        let id = readCount
        waiters.removeValue(forKey: id)?.resume()
        if concealed { throw ShannonAPIError.rejected(status: 403) }
        if hold { return try await withCheckedThrowingContinuation { continuations[id] = $0 } }
        return ShannonFeedbackReadDTO(feedback: current, operation: operationID == accepted?.operationId ? accepted : nil)
    }
}

private actor InterestsFake: ShannonInterestsServing {
    var posts = 0
    private var operationID: String?
    func loadInterests(scopeKey: String, cursor: Int?) async throws -> ShannonInterestsDTO { try interests(revision: 1, pinned: false) }
    func loadInterest(scopeKey: String, id: String, cursor: Int?) async throws -> ShannonInterestDetailDTO {
        throw ShannonAPIError.invalidResponse
    }
    func changeInterest(scopeKey: String, item: ShannonInterestDTO, action: ShannonInterestAction, changeID: String?, operationID: String) async throws -> ShannonInterestMutationDTO {
        posts += 1; self.operationID = operationID; throw URLError(.networkConnectionLost)
    }
    func loadInterestOperation(scopeKey: String, operationID: String) async throws -> ShannonInterestOperationDTO {
        ShannonInterestOperationDTO(operationId: operationID, found: self.operationID == operationID,
            result: ShannonInterestMutationDTO(code: "changed", item: try interests(revision: 2, pinned: true).items.first, revision: 2),
            latest: try interests(revision: 3, pinned: false))
    }
}

private func interests(revision: Int, pinned: Bool) throws -> ShannonInterestsDTO {
    try JSONDecoder().decode(ShannonInterestsDTO.self, from: Data("""
    {"revision":\(revision),"items":[{"id":"interest","title":"夜空","description":"星を知る","reason":"最近見直したこと",
    "revision":\(revision),"pinned":\(pinned),"banned":false,"forgotten":false,"frozen":false,"retired":false,
    "createdAt":"2026-10-08T00:00:00Z","updatedAt":"2026-10-08T00:00:00Z"}],"changes":[],"capacity":{"used":1,"limit":12},"nextCursor":null}
    """.utf8))
}
private func treeFixture() throws -> ShannonTaskTreeDTO {
    try JSONDecoder().decode(ShannonTaskTreeDTO.self, from: Data("""
    {"schema":"shannon.task-tree.v1","taskId":"task","revision":1,"rootId":"root","goal":"目的","content":"内容",
    "deadline":null,"origin":"owner_request","legacy":false,"nodes":[
    {"id":"root","parentId":null,"order":0,"dependsOn":[],"title":"元の作業","state":"wait","attemptId":null,
    "contract":{"result":"元の結果","checks":[],"constraints":["元の制約"],"boundary":["元の範囲"],"stop":[]}},
    {"id":"child","parentId":"root","order":1,"dependsOn":[],"title":"工程","state":"wait","attemptId":null,
    "contract":{"result":"元の結果","checks":[],"constraints":["元の制約"],"boundary":["元の範囲","子の追加制限"],"stop":[]}}]}
    """.utf8))
}

private actor TaskTreeFake: ShannonTaskTreeServing {
    var proposalPosts = 0
    var approvalPosts = 0
    private var tree: ShannonTaskTreeDTO
    private var proposals: [ShannonTaskTreeProposalDTO] = []
    private var hold = false
    private var readWaiter: CheckedContinuation<Void, Never>?
    private var readContinuation: CheckedContinuation<ShannonTaskTreeReadDTO, any Error>?
    init() throws { tree = try treeFixture() }
    func holdRead() { hold = true }
    func waitForRead() async {
        if readContinuation != nil { return }
        await withCheckedContinuation { readWaiter = $0 }
    }
    func finishRead() { readContinuation?.resume(returning: ShannonTaskTreeReadDTO(tree: tree, verification: nil)); readContinuation = nil }
    func loadTaskTree(scopeKey: String, taskID: String) async throws -> ShannonTaskTreeReadDTO {
        if hold { return try await withCheckedThrowingContinuation { readContinuation = $0; readWaiter?.resume(); readWaiter = nil } }
        return ShannonTaskTreeReadDTO(tree: tree, verification: nil)
    }
    func loadTaskTreeProposals(scopeKey: String, taskID: String) async throws -> [ShannonTaskTreeProposalDTO] { proposals }
    func proposeTaskTree(scopeKey: String, taskID: String, revision: Int, change: ShannonTaskTreeChangeDTO, operationID: String) async throws -> ShannonTaskTreeProposalDTO {
        proposalPosts += 1
        proposals = [ShannonTaskTreeProposalDTO(id: "proposal", taskId: taskID, expectedRevision: revision,
            diffHash: "exact-diff", change: change, state: "proposed", operationId: operationID)]
        throw URLError(.networkConnectionLost)
    }
    func approveTaskTree(scopeKey: String, proposal: ShannonTaskTreeProposalDTO) async throws -> ShannonTaskTreeDTO {
        approvalPosts += 1
        proposals = [ShannonTaskTreeProposalDTO(id: proposal.id, taskId: proposal.taskId, expectedRevision: proposal.expectedRevision,
            diffHash: proposal.diffHash, change: proposal.change, state: "approved", operationId: proposal.operationId)]
        tree = ShannonTaskTreeDTO(schema: tree.schema, taskId: tree.taskId, revision: 3, rootId: tree.rootId,
            goal: proposal.change.goal, content: proposal.change.content, deadline: proposal.change.deadline,
            origin: tree.origin, legacy: false, nodes: tree.nodes)
        throw URLError(.networkConnectionLost)
    }
}
