import Foundation
import ShannonAppCore

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

/// The auxiliary panel beside Talk: 目次, 現在地, and 「すがた」, her figure (decision 2026-10-03, roadmap A15).
/// One at a time; closing it leaves the conversation alone.
enum DesktopAuxiliaryPanel: String, CaseIterable, Hashable {
    case outline
    case task
    case figure
    var title: String {
        switch self {
        case .outline: "目次"
        case .task: "現在地"
        case .figure: ShannonGeneratedStrings.settingsFigure
        }
    }
    var symbolName: String {
        switch self {
        case .outline: "list.bullet.indent"
        case .task: "location"
        case .figure: "person.crop.rectangle"
        }
    }
    /// Her figure needs room: the panel is at least 320 wide while it shows her.
    var minimumWidth: CGFloat { self == .figure ? 320 : 230 }
    var idealWidth: CGFloat { self == .figure ? 360 : 286 }
    var maximumWidth: CGFloat { self == .figure ? 560 : 390 }
}

/// The parts of 設定 on the Mac: 管理 first (運用, 接続中の端末, 配信, 診断), then the others in the
/// order of docs/product/information-architecture.md 1. The left column lists them; the right shows one.
enum DesktopSettingsPage: String, CaseIterable, Hashable {
    case ops
    case devices
    case delivery
    case diagnostics
    case figure
    case camera
    case earphones
    case voice
    case calendar
    case appearance
    case connection
    case sources

    static let admin: [DesktopSettingsPage] = [.ops, .devices, .delivery, .diagnostics]
    static let others: [DesktopSettingsPage] = [.figure, .camera, .earphones, .voice, .calendar, .appearance, .connection, .sources]

    /// 運用 is offered only by a server that has it; the page falls back to the next part of 管理.
    static func restoring(_ rawValue: String?, opsSupported: Bool) -> DesktopSettingsPage {
        let page = rawValue.flatMap(DesktopSettingsPage.init(rawValue:)) ?? .ops
        return page == .ops && !opsSupported ? .devices : page
    }
}
