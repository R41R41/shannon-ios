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
        case .excited: "わくわく"
        case .amused: "楽しそう"
        case .laughing: "爆笑"
        case .bashful: "照れ笑い"
        case .embarrassed: "照れている"
        case .relieved: "ほっとしている"
        case .surprised: "びっくり"
        case .curious: "興味津々"
        case .thinking: "考え中"
        case .confused: "困惑している"
        case .determined: "やる気"
        case .tender: "やさしい"
        case .calm: "穏やか"
        case .jealous: "やきもち"
        case .wry: "苦笑い"
        case .exasperated: "呆れている"
        case .annoyed: "むっとしている"
        case .concerned: "心配"
        case .sad: "かなしい"
        case .sleepy: "眠そう"
        case .neutral: "いつもの表情"
        }
    }

    var accessibilityDescription: String {
        "シャノンは\(japaneseName)表情"
    }

    /// The original eight assets have a little more shoulder room than the new
    /// chat-first portraits, so give them a small, safe crop without losing the neck.
    var avatarScale: CGFloat {
        switch self {
        case .joyful, .curious, .tender, .calm, .concerned, .sad, .sleepy, .neutral:
            1.10
        default:
            1.0
        }
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
