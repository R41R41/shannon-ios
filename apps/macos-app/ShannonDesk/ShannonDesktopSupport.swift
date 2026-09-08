import Foundation
import ShannonAppCore
import SwiftUI

enum DesktopDestination: String, CaseIterable, Hashable {
    case talk
    case work
    case memory
    case settings
}

enum ShannonDesktopFocusedControl: Hashable {
    case threadSearch
}

struct ShannonDesktopCommandActions {
    let focusThreadSearch: () -> Void
    let showTalk: () -> Void
    let showWork: () -> Void
    let showMemory: () -> Void
    let showSettings: () -> Void
    let toggleInspector: () -> Void
}

private struct ShannonDesktopCommandActionsKey: FocusedValueKey {
    typealias Value = ShannonDesktopCommandActions
}

extension FocusedValues {
    var shannonDesktopCommandActions: ShannonDesktopCommandActions? {
        get { self[ShannonDesktopCommandActionsKey.self] }
        set { self[ShannonDesktopCommandActionsKey.self] = newValue }
    }
}

enum ShannonDesktopThreadSearch {
    static func matches(_ threads: [ChatThreadDTO], query: String) -> [ChatThreadDTO] {
        let foldedQuery = normalized(query)
        guard !foldedQuery.isEmpty else { return threads }
        return threads.filter { normalized($0.title).contains(foldedQuery) }
    }

    static func firstResultID(in threads: [ChatThreadDTO], query: String) -> String? {
        matches(threads, query: query).first?.threadId
    }

    private static func normalized(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(
                options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                locale: .current
            )
    }
}

struct ShannonDesktopWorkProjection {
    let active: [ShannonAgentTask]
    let proposed: [ShannonAgentTask]
    let finished: [ShannonAgentTask]

    init(tasks: [ShannonAgentTask]) {
        let sorted = tasks.sorted { $0.updatedAt > $1.updatedAt }
        active = sorted.filter { $0.status.isActive }
        proposed = sorted.filter { $0.status == .proposed }
        finished = sorted.filter { $0.status.isTerminal }
    }

    static func nextAction(for task: ShannonAgentTask) -> String {
        if task.status == .waitingApproval { return "あなたの確認後に作業を再開" }
        if let item = task.plan.first(where: { $0.status == .pending }) { return item.title }
        if task.status == .proposed { return "あなたが開始するかを選ぶ" }
        if task.status.isTerminal { return "結果を確認し、必要なら次の作業を決める" }
        return "次の作業工程を確認中"
    }
}

enum DesktopExpressionLabel {
    static func label(for expression: ShannonExpressionDTO) -> String {
        switch expression {
        case .joyful: "うれしい"
        case .excited: "わくわく"
        case .amused, .laughing: "楽しそう"
        case .bashful, .embarrassed: "少し照れている"
        case .relieved: "ほっとしている"
        case .surprised: "驚いている"
        case .curious: "興味津々"
        case .thinking, .confused: "考えている"
        case .determined: "集中している"
        case .tender: "親しみを感じている"
        case .calm, .neutral: "穏やか"
        case .jealous: "少し気になっている"
        case .wry, .exasperated, .annoyed: "少し困っている"
        case .concerned: "心配している"
        case .sad: "少し沈んでいる"
        case .sleepy: "眠そう"
        }
    }

    static func stateDescription(for expression: ShannonExpressionDTO) -> String {
        "\(label(for: expression))。作業の判断は状態ではなく、計画と検証結果に基づいて行います。"
    }
}
