import Foundation

public enum ShannonConversationDisplayMode: String, CaseIterable, Equatable, Sendable {
    case scroll
    case dialogue

    public var japaneseName: String {
        switch self {
        case .scroll: "スクロール"
        // 「向き合う」: the one name of this display (owner's decision, 2026-10-05).
        case .dialogue: ShannonGeneratedStrings.talkDisplayFacing
        }
    }

    public var symbolName: String {
        switch self {
        case .scroll: "text.bubble"
        case .dialogue: "person.crop.rectangle"
        }
    }

    public var switchActionTitle: String {
        switch self {
        case .scroll: ShannonGeneratedStrings.talkDisplayFacing
        case .dialogue: "履歴"
        }
    }

    public var switchActionSymbolName: String {
        switch self {
        case .scroll: "person.crop.rectangle"
        case .dialogue: "text.bubble"
        }
    }
}

public enum ShannonAppearanceMode: String, CaseIterable, Equatable, Identifiable, Sendable {
    case system
    case light
    case dark

    public static let storageKey = "shannon.appearance-mode"
    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .system: "端末に合わせる"
        case .light: "ライト"
        case .dark: "ダーク"
        }
    }

    public var symbolName: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max.fill"
        case .dark: "moon.fill"
        }
    }
}
