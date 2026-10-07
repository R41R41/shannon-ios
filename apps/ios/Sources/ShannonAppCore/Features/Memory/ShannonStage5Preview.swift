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
            let scenarioIndex = arguments.firstIndex(of: "-ShannonStage5Scenario")
            let scenario = scenarioIndex.flatMap { $0 + 1 < arguments.count ? ShannonStage5Preview.Scenario(rawValue: arguments[$0 + 1]) : nil } ?? .normal
            let appearanceIndex = arguments.firstIndex(of: "-ShannonStage5Appearance")
            let appearance = appearanceIndex.flatMap { $0 + 1 < arguments.count ? ["light": ColorScheme.light, "dark": .dark][arguments[$0 + 1]] : nil }
            ShannonStage5Preview(page: page, scenario: scenario).preferredColorScheme(appearance)
        } else { content }
    }
}

/// Native harness fixture only. All content and operations below are synthetic and stay in memory.
public struct ShannonStage5Preview: View {
    public enum Page: String, Sendable { case interests, feedback, taskTree }
    public enum Scenario: String, Sendable { case normal, empty, offline, conflict, unknown, others, loading }
    let page: Page
    let scenario: Scenario
    @State private var others: Bool
    @State private var interests: ShannonInterestsModel
    @State private var feedback: ShannonFeedbackModel
    @State private var task: ShannonTaskTreeModel
    private let target: ShannonFeedbackDTO
    private let feedbackClient: Stage5PreviewFeedback
    public init(page: Page, scenario: Scenario = .normal) {
        self.page = page; self.scenario = scenario
        _others = State(initialValue: scenario == .others)
        let target = ShannonFeedbackDTO(targetId: "synthetic-target", threadId: "synthetic-thread", turnId: "synthetic-turn",
                                       revision: 0, reaction: nil, operationId: nil)
        self.target = target
        let interests = ShannonInterestsModel(scopeKey: "synthetic", client: Stage5PreviewInterests(scenario: scenario))
        interests.setAudience(othersPresent: scenario == .others)
        _interests = State(initialValue: interests)
        let client = Stage5PreviewFeedback(target: target, scenario: scenario); feedbackClient = client
        let feedback = ShannonFeedbackModel(scopeKey: "synthetic", client: client)
        feedback.setContext(threadID: target.threadId, othersPresent: scenario == .others)
        if scenario != .empty { feedback.install([target], threadID: target.threadId) }
        _feedback = State(initialValue: feedback)
        let task = ShannonTaskTreeModel(scopeKey: "synthetic", taskID: "synthetic-task", client: Stage5PreviewTask(scenario: scenario))
        task.setAudience(othersPresent: scenario == .others)
        _task = State(initialValue: task)
    }
    public var body: some View {
        NavigationStack {
            Group {
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
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Toggle("同席者あり（合成）", isOn: $others).frame(minHeight: ShannonTouchTarget.minimum) }
            }
        }
        .onChange(of: others, initial: true) { _, others in
            interests.setAudience(othersPresent: others); task.setAudience(othersPresent: others)
            feedback.setContext(threadID: target.threadId, othersPresent: others)
        }
        .task(id: others) {
            if !others { await interests.loadIfNeeded() }
            if !others, scenario != .empty {
                let value = await feedbackClient.currentTarget()
                feedback.install([value], threadID: target.threadId)
            }
        }
        .safeAreaInset(edge: .bottom) {
            Text("検査用の合成データです。実際の記憶・学び・作業は変更しません。")
                .font(.shannon(.caption)).foregroundStyle(.secondary).padding(ShannonSpacing.small)
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .frame(maxWidth: .infinity).background(.background)
        }
    }
}

#endif
