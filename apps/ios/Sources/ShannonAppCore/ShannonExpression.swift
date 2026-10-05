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

    /// The face icons of 2026-10-05 (and the kind icons that join them) share one framing, so no face is
    /// cropped more than another. The earlier set needed 1.10 for its eight oldest pictures.
    var avatarScale: CGFloat {
        1.0
    }
}

enum ShannonExpressionAssets {
    static func url(for expression: ShannonExpressionDTO) -> URL? {
        url(forAsset: expression.assetName)
    }

    static func url(forAsset name: String) -> URL? {
        Bundle.module.url(forResource: name, withExtension: "png")
    }

    /// The picture of a face: the kind's own icon when the face carries one (only bundled kinds do), else the face's.
    static func assetName(for face: ShannonFace) -> String {
        face.kind?.assetName ?? face.expression.assetName
    }

#if canImport(UIKit)
    nonisolated(unsafe) private static let whiteBackgroundCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 24
        return cache
    }()

    static func uiImage(for expression: ShannonExpressionDTO) -> UIImage? {
        uiImage(forAsset: expression.assetName)
    }

    static func uiImage(forAsset name: String) -> UIImage? {
        let key = name as NSString
        if let cached = whiteBackgroundCache.object(forKey: key) { return cached }
        guard let source = (UIImage(named: name, in: .module, compatibleWith: nil)
            ?? url(forAsset: name).flatMap({ UIImage(contentsOfFile: $0.path) }))?.cgImage,
              let rendered = ShannonPortraitBackground.whitened(source) else { return nil }
        let image = UIImage(cgImage: rendered, scale: 1, orientation: .up)
        whiteBackgroundCache.setObject(image, forKey: key)
        return image
    }
#elseif canImport(AppKit)
    nonisolated(unsafe) private static let whiteBackgroundCache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 24
        return cache
    }()

    static func nsImage(for expression: ShannonExpressionDTO) -> NSImage? {
        nsImage(forAsset: expression.assetName)
    }

    /// The Mac shows the same icons as the iPhone, on the same white canvas.
    static func nsImage(forAsset name: String) -> NSImage? {
        let key = name as NSString
        if let cached = whiteBackgroundCache.object(forKey: key) { return cached }
        guard let source = url(forAsset: name).flatMap(NSImage.init(contentsOf:))?
            .cgImage(forProposedRect: nil, context: nil, hints: nil),
              let rendered = ShannonPortraitBackground.whitened(source) else { return nil }
        let image = NSImage(cgImage: rendered, size: NSSize(width: rendered.width, height: rendered.height))
        whiteBackgroundCache.setObject(image, forKey: key)
        return image
    }
#endif
}

enum ShannonDialogueAssets {
    static let stagePortraitName = "shannon-dialogue-stage-v2"

    static var stagePortraitURL: URL? {
        Bundle.module.url(forResource: stagePortraitName, withExtension: "png")
    }
}
