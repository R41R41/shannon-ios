#if DEBUG
import Foundation
import SwiftUI

/// The outermost app-root modifier replaces, rather than overlays, the live view during a requested harness case.
public struct ShannonStage5PreviewModifier: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("-ShannonDesignPreview"),
           let index = arguments.firstIndex(of: "-ShannonStage5Preview"), index + 1 < arguments.count,
           let page = ShannonStage5Preview.Page(rawValue: arguments[index + 1]) {
            ShannonStage5Preview(page: page)
        } else { content }
    }
}

/// Native harness fixture only. All content and operations below are synthetic and stay in memory.
public struct ShannonStage5Preview: View {
    public enum Page: String, Sendable { case interests, feedback, taskTree }
    let page: Page
    @State private var interests: ShannonInterestsModel
    @State private var feedback: ShannonFeedbackModel
    @State private var task: ShannonTaskTreeModel
    private let target: ShannonFeedbackDTO
    public init(page: Page) {
        self.page = page
        let target = ShannonFeedbackDTO(targetId: "synthetic-target", threadId: "synthetic-thread", turnId: "synthetic-turn",
                                       revision: 0, reaction: nil, operationId: nil)
        self.target = target
        _interests = State(initialValue: ShannonInterestsModel(scopeKey: "synthetic", client: Stage5PreviewInterests()))
        let feedback = ShannonFeedbackModel(scopeKey: "synthetic", client: Stage5PreviewFeedback(target: target))
        feedback.setContext(threadID: target.threadId, othersPresent: false); feedback.install([target], threadID: target.threadId)
        _feedback = State(initialValue: feedback)
        _task = State(initialValue: ShannonTaskTreeModel(scopeKey: "synthetic", taskID: "synthetic-task", client: Stage5PreviewTask()))
    }
    public var body: some View {
        NavigationStack {
            switch page {
            case .interests: ShannonInterestsView(model: interests)
            case .feedback:
                ScrollView {
                    VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                        Text("週末に読む記事を探して。")
                        Divider()
                        Text("保存した記事を確認しました。夜空の観察と、暮らしの道具についての記事がありました。")
                        ShannonFeedbackView(target: target, model: feedback)
                        Divider()
                        Text("今日はゆっくり話しましょう。")
                        Text("通常の会話には反応のボタンを付けません。")
                            .font(.shannon(.caption)).foregroundStyle(.secondary)
                    }.padding(ShannonSpacing.large)
                }.navigationTitle("トーク・合成確認")
            case .taskTree:
                ScrollView { ShannonTaskTreeView(model: task).padding(ShannonSpacing.large) }
                    .navigationTitle("作業の詳細・合成確認")
            }
        }
        .safeAreaInset(edge: .bottom) {
            Text("検査用の合成データです。実際の記憶・学び・作業は変更しません。")
                .font(.shannon(.caption)).foregroundStyle(.secondary).padding(ShannonSpacing.small)
        }
    }
}

private actor Stage5PreviewFeedback: ShannonFeedbackServing {
    private var current: ShannonFeedbackDTO
    private var operations: [String: ShannonFeedbackDTO] = [:]
    init(target: ShannonFeedbackDTO) { current = target }
    func loadFeedback(scopeKey: String, target: ShannonFeedbackDTO, operationID: String?) async throws -> ShannonFeedbackReadDTO {
        ShannonFeedbackReadDTO(feedback: current, operation: operationID.flatMap { operations[$0] })
    }
    func changeFeedback(scopeKey: String, target: ShannonFeedbackDTO, reaction: ShannonFeedbackReaction?, operationID: String) async throws -> ShannonFeedbackDTO {
        if let existing = operations[operationID] { return existing }
        guard current.revision == target.revision else { throw ShannonAPIError.rejected(status: 409) }
        current = ShannonFeedbackDTO(targetId: target.targetId, threadId: target.threadId, turnId: target.turnId,
            revision: current.revision + 1, reaction: reaction, operationId: operationID)
        operations[operationID] = current
        return current
    }
}

private actor Stage5PreviewInterests: ShannonInterestsServing {
    private var revision = 1
    private var pinned = false
    private var banned = false
    private var frozen = false
    private var forgotten = false
    private var undone = false
    private var operations: [String: ShannonInterestMutationDTO] = [:]
    private var item: ShannonInterestDTO {
        ShannonInterestDTO(id: "synthetic-interest", title: forgotten ? "（表示しない関心）" : "夜空を観察する",
            description: forgotten ? "" : undone ? "星と星座を知る" : "星と星座を知り、観察の方法も試す",
            reason: forgotten ? "" : "最近、星の見え方や観察する道具について話したため。",
            weight: 0.6, evidenceRefs: forgotten ? [] : ["synthetic-evidence"], revision: revision, pinned: pinned, banned: banned,
            forgotten: forgotten, frozen: frozen, retired: false, createdAt: "2026-10-07T22:00:00Z", updatedAt: "2026-10-08T00:00:00Z")
    }
    private var changes: [ShannonInterestChangeDTO] {
        [ShannonInterestChangeDTO(changeId: "synthetic-change", seq: 1, itemId: item.id, actor: "sleep", kind: "patch",
            reason: item.reason, before: nil, after: item, nightKey: "2026-10-07", createdAt: "2026-10-07T22:00:00Z")]
    }
    private var snapshot: ShannonInterestsDTO {
        ShannonInterestsDTO(revision: revision, items: [item], changes: changes,
                           capacity: .init(used: item.active ? 1 : 0, limit: 12), nextCursor: nil)
    }
    func loadInterests(scopeKey: String, cursor: Int?) async throws -> ShannonInterestsDTO { snapshot }
    func loadInterest(scopeKey: String, id: String, cursor: Int?) async throws -> ShannonInterestDetailDTO {
        let evidence = ShannonInterestDetailDTO.Evidence(status: forgotten ? "hidden" : "available", total: forgotten ? 0 : 1,
            items: forgotten ? [] : [.init(id: "synthetic-evidence", text: "週末、暗い場所で星を見たい。観察するときの道具も知りたい。", truncated: false)], omitted: 0)
        return ShannonInterestDetailDTO(revision: revision, item: item, changes: changes, nextCursor: nil, evidence: evidence)
    }
    func changeInterest(scopeKey: String, item: ShannonInterestDTO, action: ShannonInterestAction, changeID: String?, operationID: String) async throws -> ShannonInterestMutationDTO {
        if let existing = operations[operationID] { return existing }
        guard revision == item.revision else { throw ShannonAPIError.rejected(status: 409) }
        switch action {
        case .undo: undone = true; frozen = true
        case .pin: pinned = true
        case .unpin: pinned = false
        case .ban: banned = true
        case .unban: banned = false
        case .forget: forgotten = true
        case .resume: frozen = false
        }
        revision += 1
        let result = ShannonInterestMutationDTO(code: "changed", item: self.item, revision: revision)
        operations[operationID] = result
        return result
    }
    func loadInterestOperation(scopeKey: String, operationID: String) async throws -> ShannonInterestOperationDTO {
        ShannonInterestOperationDTO(operationId: operationID, found: operations[operationID] != nil,
                                    result: operations[operationID], latest: snapshot)
    }
}

private actor Stage5PreviewTask: ShannonTaskTreeServing {
    private var revision = 1
    private var goal = "読みものを整理する"
    private var content = "保存した記事を分類し、探しやすい一覧にする"
    private var proposals: [ShannonTaskTreeProposalDTO] = []
    private var adopted: ShannonTaskTreeChangeDTO?
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
        return ShannonTaskTreeDTO(schema: "shannon.task-tree.v1", taskId: "synthetic-task", revision: revision, rootId: "synthetic-root",
            goal: goal, content: content, deadline: nil, origin: "owner_request", legacy: false, nodes: [
                .init(id: "synthetic-root", parentId: nil, order: 0, dependsOn: [], title: "読みものを整理する", contract: contract, state: "wait", attemptId: nil),
                .init(id: "synthetic-first", parentId: "synthetic-root", order: 0, dependsOn: [], title: "記事を確認する", contract: contract, state: "done", attemptId: nil),
                .init(id: "synthetic-second", parentId: "synthetic-root", order: 1, dependsOn: ["synthetic-first"], title: "分類した一覧を作る", contract: contract, state: "continue", attemptId: nil),
            ])
    }
    func loadTaskTree(scopeKey: String, taskID: String) async throws -> ShannonTaskTreeReadDTO {
        ShannonTaskTreeReadDTO(tree: tree, verification: .init(status: "invalid", evidenceIds: nil))
    }
    func loadTaskTreeProposals(scopeKey: String, taskID: String) async throws -> [ShannonTaskTreeProposalDTO] { proposals }
    func proposeTaskTree(scopeKey: String, taskID: String, revision: Int, change: ShannonTaskTreeChangeDTO, operationID: String) async throws -> ShannonTaskTreeProposalDTO {
        let value = ShannonTaskTreeProposalDTO(id: UUID().uuidString, taskId: taskID, expectedRevision: revision,
            diffHash: "synthetic-diff", change: change, state: "proposed", operationId: operationID)
        proposals.append(value); return value
    }
    func approveTaskTree(scopeKey: String, proposal: ShannonTaskTreeProposalDTO) async throws -> ShannonTaskTreeDTO {
        guard revision == proposal.expectedRevision else { throw ShannonAPIError.rejected(status: 409) }
        goal = proposal.change.goal; content = proposal.change.content; revision += 1
        adopted = proposal.change
        proposals = proposals.map { $0.id == proposal.id ? .init(id: $0.id, taskId: $0.taskId,
            expectedRevision: $0.expectedRevision, diffHash: $0.diffHash, change: $0.change, state: "approved", operationId: $0.operationId) : $0 }
        return tree
    }
}
#endif
