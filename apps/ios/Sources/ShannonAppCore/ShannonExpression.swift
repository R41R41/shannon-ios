import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

extension ShannonExpressionDTO {
    var assetName: String {
        "shannon-expression-\(rawValue)"
    }

    var japaneseName: String {
        switch self {
        case .joyful: "うれしい"
        case .curious: "興味津々"
        case .tender: "やさしい"
        case .calm: "穏やか"
        case .concerned: "心配"
        case .sad: "かなしい"
        case .sleepy: "眠そう"
        case .neutral: "いつもの表情"
        }
    }

    var accessibilityDescription: String {
        "シャノンは\(japaneseName)表情"
    }
}

enum ShannonExpressionAssets {
    static func url(for expression: ShannonExpressionDTO) -> URL? {
        Bundle.module.url(forResource: expression.assetName, withExtension: "png")
    }

#if canImport(UIKit)
    static func uiImage(for expression: ShannonExpressionDTO) -> UIImage? {
        UIImage(named: expression.assetName, in: .module, compatibleWith: nil)
            ?? url(for: expression).flatMap { UIImage(contentsOfFile: $0.path) }
    }
#elseif canImport(AppKit)
    static func nsImage(for expression: ShannonExpressionDTO) -> NSImage? {
        guard let url = url(for: expression) else { return nil }
        return NSImage(contentsOf: url)
    }
#endif
}
