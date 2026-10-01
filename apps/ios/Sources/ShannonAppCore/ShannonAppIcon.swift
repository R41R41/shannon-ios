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
    public var assetCatalogName: String {
        switch self {
        case .level02: "ShannonL02"
        case .level06: "ShannonL06"
        case .level10: "ShannonL10"
        }
    }
    public var previewAssetName: String { "\(assetCatalogName)-1024" }
    public var alternateIconName: String? { self == .level06 ? nil : assetCatalogName }

    static func resolvingAlternateIconName(_ name: String?) -> Self {
        switch name {
        case nil, "ShannonL06", Self.level06.rawValue: .level06
        case "ShannonL02", Self.level02.rawValue: .level02
        case "ShannonL10", Self.level10.rawValue: .level10
        default: .defaultChoice
        }
    }

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

enum ShannonAppIconAssets {
#if canImport(AppKit)
    static let macApplicationIconBodyScale = 0.84375
    static let macApplicationIconCornerRadiusRatio = 0.223
#endif

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

    static func macApplicationIcon(for assetName: String) -> NSImage? {
        guard
            let source = nsImage(for: assetName),
            let sourceImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil),
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(
                data: nil,
                width: sourceImage.width,
                height: sourceImage.height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return nil }

        let bodyPixelSize = Int(
            (Double(min(sourceImage.width, sourceImage.height)) * macApplicationIconBodyScale).rounded()
        )
        let bounds = CGRect(
            x: (sourceImage.width - bodyPixelSize) / 2,
            y: (sourceImage.height - bodyPixelSize) / 2,
            width: bodyPixelSize,
            height: bodyPixelSize
        )
        let radius = CGFloat(bodyPixelSize) * macApplicationIconCornerRadiusRatio
        context.addPath(CGPath(
            roundedRect: bounds,
            cornerWidth: radius,
            cornerHeight: radius,
            transform: nil
        ))
        context.clip()
        context.interpolationQuality = .high
        context.draw(sourceImage, in: bounds)
        guard let maskedImage = context.makeImage() else { return nil }
        return NSImage(cgImage: maskedImage, size: NSSize(width: sourceImage.width, height: sourceImage.height))
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
    private let defaults: UserDefaults

    enum Keys {
        static let selectedChoice = "shannon.app-icon.level-choice"
        static let legacyManualChoice = "shannon.app-icon.manual-choice"
        static let legacyMode = "shannon.app-icon.mode"
    }

    public convenience init() {
#if canImport(UIKit)
        self.init(defaults: .standard, activeAlternateIconName: UIApplication.shared.alternateIconName)
#else
        self.init(defaults: .standard, activeAlternateIconName: nil)
#endif
    }

    init(defaults: UserDefaults, activeAlternateIconName: String?) {
        self.defaults = defaults
        let storedChoice = defaults.string(forKey: Keys.selectedChoice)
            .flatMap(ShannonAppIconChoice.init(rawValue:))
        let initialChoice = storedChoice ?? ShannonAppIconChoice.defaultChoice
        selectedChoice = initialChoice

#if canImport(UIKit)
        activeChoice = ShannonAppIconChoice.resolvingAlternateIconName(activeAlternateIconName)
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

    /// Re-applies the owner's chosen level at launch. The icon never follows Shannon's
    /// emotion or the appearance; the owner picks one of the three levels in Settings.
    public func activate() async {
        await apply(choice: selectedChoice)
    }

    public func select(_ choice: ShannonAppIconChoice) async {
        selectedChoice = choice
        defaults.set(choice.rawValue, forKey: Keys.selectedChoice)
        await apply(choice: choice)
    }

    public func dismissError() { errorMessage = nil }

    public func refresh() {
#if canImport(UIKit)
        activeChoice = ShannonAppIconChoice.resolvingAlternateIconName(UIApplication.shared.alternateIconName)
#else
        activeChoice = selectedChoice
#endif
    }

#if canImport(AppKit)
    public func restoreMacApplicationIconBeforeWindowCreation() {
        guard selectedChoice != .defaultChoice else { return }
        applyMacApplicationIcon(selectedChoice)
    }
#endif

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
        applyMacApplicationIcon(choice)
#else
        activeChoice = choice
#endif
    }

#if canImport(AppKit)
    private func applyMacApplicationIcon(_ choice: ShannonAppIconChoice) {
        guard let image = ShannonAppIconAssets.macApplicationIcon(for: choice.previewAssetName) else {
            errorMessage = "アイコン画像を読み込めませんでした。"
            return
        }
        NSApplication.shared.applicationIconImage = image
        activeChoice = choice
    }
#endif
}
