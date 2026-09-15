import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public enum ShannonAppIconChoice: String, CaseIterable, Identifiable, Sendable {
    case level02 = "ShannonIconL02"
    case level06 = "ShannonIconL06"
    case level10 = "ShannonIconL10"

    public static let defaultChoice: Self = .level06
    public static let selectableChoices: [Self] = [.level02, .level06, .level10]

    public var id: String { rawValue }
    public var previewAssetName: String { "shannon-app-icon-preview-\(rawValue)" }
    public var alternateIconName: String? { self == .level06 ? nil : rawValue }

    public var japaneseName: String {
        switch self {
        case .level02: "立体"
        case .level06: "バランス"
        case .level10: "フラット"
        }
    }

    public var levelName: String {
        switch self {
        case .level02: "L02"
        case .level06: "L06"
        case .level10: "L10"
        }
    }

    public var detail: String {
        switch self {
        case .level02: "質感と存在感を強く"
        case .level06: "標準・おすすめ"
        case .level10: "最もシンプルに"
        }
    }
}

public enum ShannonAppIconAppearance: String, Equatable, Sendable {
    case light
    case dark
}

enum ShannonAppIconAssets {
    static func url(for assetName: String) -> URL? {
        Bundle.module.url(forResource: assetName, withExtension: "png")
    }

#if canImport(UIKit)
    static func uiImage(for assetName: String) -> UIImage? {
        guard let url = url(for: assetName) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }
#elseif canImport(AppKit)
    static func nsImage(for assetName: String) -> NSImage? {
        guard let url = url(for: assetName) else { return nil }
        return NSImage(contentsOf: url)
    }
#endif
}

@MainActor
@Observable
public final class ShannonAppIconModel {
    public private(set) var selectedChoice: ShannonAppIconChoice
    public private(set) var activeChoice: ShannonAppIconChoice
    public private(set) var isUpdating = false
    public private(set) var errorMessage: String?
    public private(set) var nextRefreshAt: Date?

    private enum Keys {
        static let selectedChoice = "shannon.app-icon.level-choice"
        static let legacyManualChoice = "shannon.app-icon.manual-choice"
        static let legacyMode = "shannon.app-icon.mode"
    }

    public init() {
        let defaults = UserDefaults.standard
        let storedChoice = defaults.string(forKey: Keys.selectedChoice)
            .flatMap(ShannonAppIconChoice.init(rawValue:))
        let initialChoice = storedChoice ?? ShannonAppIconChoice.defaultChoice
        selectedChoice = initialChoice

#if canImport(UIKit)
        activeChoice = Self.choice(forAlternateIconName: UIApplication.shared.alternateIconName)
#else
        activeChoice = initialChoice
#endif

        if storedChoice == nil {
            defaults.set(ShannonAppIconChoice.defaultChoice.rawValue, forKey: Keys.selectedChoice)
        }
        defaults.removeObject(forKey: Keys.legacyManualChoice)
        defaults.removeObject(forKey: Keys.legacyMode)
    }

    public var activeTitle: String {
        "\(activeChoice.levelName)・\(activeChoice.japaneseName)"
    }

    public func activate(
        for expression: ShannonExpressionDTO,
        appearance: ShannonAppIconAppearance,
        now: Date = Date(),
        recordsLateNightUse: Bool = true
    ) async {
        _ = expression
        _ = appearance
        _ = now
        _ = recordsLateNightUse
        await apply(choice: selectedChoice)
    }

    public func select(_ choice: ShannonAppIconChoice) async {
        selectedChoice = choice
        UserDefaults.standard.set(choice.rawValue, forKey: Keys.selectedChoice)
        await apply(choice: choice)
    }

    public func updateAutomatically(
        for expression: ShannonExpressionDTO,
        now: Date = Date(),
        force: Bool = false
    ) async {
        _ = expression
        _ = now
        _ = force
    }

    public func updateForAppearance(
        _ appearance: ShannonAppIconAppearance,
        now: Date = Date()
    ) async {
        _ = appearance
        _ = now
    }

    public func dismissError() { errorMessage = nil }

    public func refresh() {
#if canImport(UIKit)
        activeChoice = Self.choice(forAlternateIconName: UIApplication.shared.alternateIconName)
#else
        activeChoice = selectedChoice
#endif
    }

    private static func choice(forAlternateIconName name: String?) -> ShannonAppIconChoice {
        guard let name else { return .defaultChoice }
        return ShannonAppIconChoice(rawValue: name) ?? .defaultChoice
    }

    private func apply(choice: ShannonAppIconChoice) async {
#if canImport(UIKit)
        guard UIApplication.shared.supportsAlternateIcons else {
            errorMessage = "この端末ではアイコンを切り替えられません。"
            return
        }
        let alternateIconName = choice.alternateIconName
        guard UIApplication.shared.alternateIconName != alternateIconName else {
            activeChoice = choice
            return
        }

        isUpdating = true
        errorMessage = nil
        let failure: String? = await withCheckedContinuation { continuation in
            UIApplication.shared.setAlternateIconName(alternateIconName) { error in
                continuation.resume(returning: error?.localizedDescription)
            }
        }
        isUpdating = false
        if let failure {
            errorMessage = "アイコンを変更できませんでした: \(failure)"
            refresh()
            return
        }
        activeChoice = choice
#elseif canImport(AppKit)
        guard let image = ShannonAppIconAssets.nsImage(for: choice.previewAssetName) else {
            errorMessage = "アイコン画像を読み込めませんでした。"
            return
        }
        NSApplication.shared.applicationIconImage = image
        activeChoice = choice
#else
        activeChoice = choice
#endif
    }
}
