import Foundation

/// The places of Shannon Desk. The sidebar shows four pillars (docs/product/information-architecture.md):
/// トーク／作業／シャノン at the top and 設定 at the bottom. 開発 and 配信 are pages inside 作業
/// (roadmap A10); 配信 also opens from 設定 › 管理.
enum DesktopDestination: String, CaseIterable, Hashable {
    case talk
    case work
    case shannon
    case development
    case release
    case settings

    /// Reads a stored value, including the places of the Mac before the four pillars:
    /// 頭の中 (`memory`) now lives in シャノン.
    init?(restoring rawValue: String) {
        if rawValue == "memory" {
            self = .shannon
        } else {
            self.init(rawValue: rawValue)
        }
    }

    /// The pillar whose sidebar row is selected while this place is shown.
    var pillar: DesktopPillar {
        switch self {
        case .talk: .talk
        case .work, .development, .release: .work
        case .shannon: .shannon
        case .settings: .settings
        }
    }
}

/// The four entries. Talk, work and Shannon are rows at the top of the sidebar; settings is its last row.
enum DesktopPillar: String, CaseIterable, Hashable {
    case talk
    case work
    case shannon
    case settings
}

/// The pages of 作業 on the Mac: the task list, and the desktop additions 開発 and 配信.
enum DesktopWorkPage: String, CaseIterable, Hashable, Identifiable {
    case tasks
    case development
    case release

    var id: String { rawValue }

    var destination: DesktopDestination {
        switch self {
        case .tasks: .work
        case .development: .development
        case .release: .release
        }
    }

    init?(destination: DesktopDestination) {
        switch destination {
        case .work: self = .tasks
        case .development: self = .development
        case .release: self = .release
        case .talk, .shannon, .settings: return nil
        }
    }
}

/// The second column of シャノン: the card opens ようす, then 頭の中／自律活動／書斎.
enum DesktopShannonPage: String, CaseIterable, Hashable {
    case now
    case memory
    case autonomy
    case study

    static func restoring(_ rawValue: String?) -> DesktopShannonPage {
        rawValue.flatMap(DesktopShannonPage.init(rawValue:)) ?? .now
    }
}

enum DesktopAuxiliaryPanel: String, CaseIterable, Hashable {
    case outline
    case task
    var title: String {
        switch self {
        case .outline: "目次"
        case .task: "現在地"
        }
    }
    var symbolName: String {
        switch self {
        case .outline: "list.bullet.indent"
        case .task: "location"
        }
    }
}
