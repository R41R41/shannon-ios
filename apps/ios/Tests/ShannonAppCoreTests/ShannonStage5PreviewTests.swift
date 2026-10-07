#if DEBUG
import Foundation
import Testing
@testable import ShannonAppCore

@Suite @MainActor
struct ShannonStage5PreviewTests {
    @Test func journalVersionsStayImmutableAndUndoFreezesOnlyTheItem() async throws {
        let client = Stage5PreviewInterests()
        let model = ShannonInterestsModel(scopeKey: "synthetic", client: client)
        await model.reload()
        let original = try #require(model.changes.first)
        let item = try #require(model.snapshot?.items.first)
        #expect(original.before != nil)
        await model.perform(item: item, action: .pin)
        #expect(model.changes.first(where: { $0.id == original.id }) == original)
        await model.perform(item: try #require(model.item(item.id)), action: .undo, changeID: original.id)
        let undone = try #require(model.item(item.id))
        #expect(undone.description == original.before?.description)
        #expect(undone.frozen && undone.pinned)
        #expect(model.changes.first(where: { $0.id == original.id }) == original)
        await model.perform(item: undone, action: .resume)
        #expect(model.item(item.id)?.frozen == false)
        await model.perform(item: try #require(model.item(item.id)), action: .forget)
        #expect(model.changes.allSatisfy { $0.after.description.isEmpty && ($0.before?.description.isEmpty ?? true) })
        await model.loadDetail(item.id)
        #expect(model.details[item.id]?.evidence?.status == "hidden")
    }

    @Test func unknownScenariosExposeGetConfirmationWithoutPostingAgain() async throws {
        let target = ShannonFeedbackDTO(targetId: "synthetic-target", threadId: "synthetic-thread", turnId: "synthetic-turn",
            revision: 0, reaction: nil, operationId: nil)
        let feedbackClient = Stage5PreviewFeedback(target: target, scenario: .unknown)
        let feedback = ShannonFeedbackModel(scopeKey: "synthetic", client: feedbackClient)
        feedback.setContext(threadID: target.threadId, othersPresent: false)
        feedback.install([target], threadID: target.threadId)
        await feedback.choose(.good, target: target)
        #expect(!feedback.pending.isEmpty)
        await feedback.check(target)
        #expect(feedback.pending.isEmpty)
        #expect(feedback.state(for: target)?.reaction == .good)
        #expect(await feedbackClient.posts == 1)

        let interestClient = Stage5PreviewInterests(scenario: .unknown)
        let interests = ShannonInterestsModel(scopeKey: "synthetic", client: interestClient)
        await interests.reload()
        await interests.perform(item: try #require(interests.snapshot?.items.first), action: .pin)
        #expect(interests.pending != nil)
        await interests.checkPending()
        #expect(interests.pending == nil)
        #expect(interests.snapshot?.items.first?.pinned == true)
        #expect(await interestClient.posts == 1)

        let taskClient = Stage5PreviewTask(scenario: .unknown)
        let task = ShannonTaskTreeModel(scopeKey: "synthetic", taskID: "synthetic-task", client: taskClient)
        await task.reload()
        var change = ShannonTaskTreeChangeDTO(tree: try #require(task.read?.tree))
        change.goal = "合成の変更案"
        await task.propose(change)
        #expect(task.pending != nil)
        await task.reload()
        #expect(task.pending == nil)
        #expect(await taskClient.proposalPosts == 1)
        await task.approve(try #require(task.proposals.first))
        #expect(task.pending != nil)
        await task.reload()
        #expect(task.pending == nil)
        #expect(task.read?.tree.goal == change.goal)
        #expect(await taskClient.approvalPosts == 1)
    }

    @Test func conflictShowsOtherDeviceRevisionWithoutApplyingRefusedChange() async throws {
        let client = Stage5PreviewInterests(scenario: .conflict)
        let model = ShannonInterestsModel(scopeKey: "synthetic", client: client)
        await model.reload()
        await model.perform(item: try #require(model.snapshot?.items.first), action: .ban)
        #expect(model.pending == nil && model.fresh)
        #expect(model.snapshot?.revision == 2)
        #expect(model.snapshot?.items.first?.pinned == true)
        #expect(model.snapshot?.items.first?.banned == false)
        #expect(await client.posts == 1)
    }

    @Test func offlinePreviewInitialGetCanBeRetriedAndAudienceClearHidesContent() async {
        let taskClient = Stage5PreviewTask(scenario: .offline)
        let task = ShannonTaskTreeModel(scopeKey: "synthetic", taskID: "synthetic-task", client: taskClient)
        await task.reload()
        #expect(task.showsInitialReadError)
        await task.reload()
        #expect(task.read != nil && task.fresh)
        task.setAudience(othersPresent: true)
        #expect(task.read == nil && task.proposals.isEmpty)
        let interests = ShannonInterestsModel(scopeKey: "synthetic", client: Stage5PreviewInterests(scenario: .empty))
        await interests.reload()
        #expect(interests.snapshot?.items.isEmpty == true && interests.changes.isEmpty)
        interests.setAudience(othersPresent: true)
        #expect(interests.snapshot == nil && !interests.offered)
    }
}
#endif
