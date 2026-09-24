import Foundation

/// The management list is derived from durable items, never from optional
/// overview projections (activity, knowledge, or currentState).
struct ShannonMemoryLibrary: Equatable {
    enum SectionID: String, CaseIterable, Identifiable {
        case pending, closed, remembered, hidden
        var id: String { rawValue }
        var title: String {
            switch self {
            case .pending: "未完了の約束"
            case .closed: "終えた約束"
            case .remembered: "保存した記憶"
            case .hidden: "忘れた・事実ではない記憶"
            }
        }
        var emptyMessage: String {
            switch self {
            case .pending: "未完了の約束はありません。"
            case .closed: "完了・取り消し済みの約束はありません。"
            case .remembered: "保存した記憶はまだありません。"
            case .hidden: "忘れた・事実ではないと指定した記憶はありません。"
            }
        }
    }

    let items: [ShannonMemoryItemDTO]

    init(dashboard: ShannonMemoryDashboardDTO?) {
        items = dashboard?.items ?? []
    }

    func items(in section: SectionID) -> [ShannonMemoryItemDTO] {
        items.filter { item in
            switch section {
            case .hidden: item.status != .active
            case .remembered: item.status == .active && item.commitment == nil
            case .pending: item.status == .active && item.commitment?.status == "pending"
            case .closed: item.status == .active && item.commitment != nil && item.commitment?.status != "pending"
            }
        }
    }

    var summary: String {
        "未完了の約束 \(items(in: .pending).count)件・保存した記憶 \(items(in: .remembered).count)件"
    }
}
