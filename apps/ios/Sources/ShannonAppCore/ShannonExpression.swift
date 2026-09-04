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
    nonisolated(unsafe) private static let whiteBackgroundCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 24
        return cache
    }()

    static func uiImage(for expression: ShannonExpressionDTO) -> UIImage? {
        let key = expression.assetName as NSString
        if let cached = whiteBackgroundCache.object(forKey: key) { return cached }
        guard let source = UIImage(named: expression.assetName, in: .module, compatibleWith: nil)
            ?? url(for: expression).flatMap({ UIImage(contentsOfFile: $0.path) }),
              let rendered = source.replacingPaleEdgeColorWithWhite() else { return nil }
        whiteBackgroundCache.setObject(rendered, forKey: key)
        return rendered
    }
#elseif canImport(AppKit)
    static func nsImage(for expression: ShannonExpressionDTO) -> NSImage? {
        guard let url = url(for: expression) else { return nil }
        return NSImage(contentsOf: url)
    }
#endif
}

enum ShannonDialogueAssets {
    static let stagePortraitName = "shannon-dialogue-stage-v2"

    static var stagePortraitURL: URL? {
        Bundle.module.url(forResource: stagePortraitName, withExtension: "png")
    }
}

#if canImport(UIKit)
private extension UIImage {
    /// Generated portraits use a pale lavender canvas. Normalize that canvas to
    /// pure white at display time while preserving blue hair, skin, and outlines.
    func replacingPaleEdgeColorWithWhite() -> UIImage? {
        let outputSide = 384
        let bytesPerPixel = 4
        let bytesPerRow = outputSide * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: outputSide * bytesPerRow)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB), let source = cgImage else { return nil }
        let rendered = pixels.withUnsafeMutableBytes { buffer -> CGImage? in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: outputSide,
                height: outputSide,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return nil }
            context.interpolationQuality = .high
            context.draw(source, in: CGRect(x: 0, y: 0, width: outputSide, height: outputSide))
            for index in stride(from: 0, to: buffer.count, by: bytesPerPixel) {
                let red = Int(buffer[index])
                let green = Int(buffer[index + 1])
                let blue = Int(buffer[index + 2])
                let isPaleLavender = red > 210 && green > 198 && blue > 220
                    && blue >= red - 6 && blue >= green + 5
                if isPaleLavender {
                    buffer[index] = 255
                    buffer[index + 1] = 255
                    buffer[index + 2] = 255
                }
            }
            return context.makeImage()
        }
        guard let rendered else { return nil }
        return UIImage(cgImage: rendered, scale: 1, orientation: .up)
    }
}
#endif
