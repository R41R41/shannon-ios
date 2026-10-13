import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The owner's switch 「会話中にシャノンがカメラで見る」. On unless he turned it off.
public enum ShannonAppLookPreference {
    public static let enabledDefaultsKey = "shannon.app-look.enabled"

    public static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledDefaultsKey) as? Bool ?? true
    }
}

/// What the app can say about its camera, decided from facts in one order:
/// the owner's switch, the screen, the hardware, then the system's permission.
public enum ShannonAppLookAvailability {
    public static func state(
        enabled: Bool, foreground: Bool, permission: ShannonMediaPermission, cameras: [ShannonAppLookCamera]
    ) -> ShannonAppLookClientStateDTO.State {
        if !enabled { return .switchedOff }
        if !foreground { return .background }
        if cameras.isEmpty { return .noCamera }
        switch permission {
        case .denied: return .denied
        case .undetermined: return .undetermined
        case .granted: return .ready
        }
    }

    /// Why a look that was asked for is not taken, or nil when the camera may open.
    /// An `undetermined` permission is not a refusal: the system is asked first.
    public static func refusal(_ state: ShannonAppLookClientStateDTO.State) -> ShannonAppLookRefusal? {
        switch state {
        case .ready, .undetermined: nil
        case .background: .background
        case .denied: .denied
        case .noCamera: .noCamera
        case .switchedOff: .switchedOff
        }
    }

    public static var platform: String {
#if os(macOS)
        "macos"
#else
        "ios"
#endif
    }
}

/// Fits one captured image into what the server accepts and what a model needs:
/// the long side at most 960 pixels, JPEG, at most 400,000 bytes. Nothing is written to disk.
public enum ShannonAppLookEncoder {
    public static let maximumSide = 960
    public static let maximumBytes = 400_000
    public static let thumbnailSide = 160

    public static func frame(from image: CGImage) -> ShannonAppLookFrame? {
        frame(from: image, maximumSide: maximumSide, maximumBytes: maximumBytes)
    }

    /// The same, with a smaller bound: watching sends at most 512 pixels and 200,000 bytes (Syzygy ADR-0011 §4.4).
    public static func frame(from image: CGImage, maximumSide: Int, maximumBytes: Int) -> ShannonAppLookFrame? {
        guard let scaled = resized(image, maximumSide: maximumSide) else { return nil }
        for quality in [0.72, 0.58, 0.44, 0.3] {
            if let data = jpeg(scaled, quality: quality), data.count <= maximumBytes {
                return ShannonAppLookFrame(jpeg: data, width: scaled.width, height: scaled.height)
            }
        }
        return nil
    }

    /// The small picture shown with 「いま見ました」. Held in memory for a few seconds only.
    public static func thumbnail(from image: CGImage) -> CGImage? {
        resized(image, maximumSide: thumbnailSide)
    }

    static func resized(_ image: CGImage, maximumSide: Int) -> CGImage? {
        let longest = max(image.width, image.height)
        guard longest > 0 else { return nil }
        let scale = min(1, Double(maximumSide) / Double(longest))
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    static func jpeg(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        // No metadata is attached: a bare bitmap has no location, device, or time to carry.
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}

/// Copy of the look, in one place.
public enum ShannonAppLookCopy {
    public static let sectionTitle = ShannonGeneratedStrings.settingsSectionCamera
    public static let toggleTitle = ShannonGeneratedStrings.lookSetting
    public static let toggleHint = "オンにすると、アプリを開いて話している時に、見てと言われた時や気になった時だけシャノンがカメラで1枚見ます。オフにすると見ません"
    public static let explanation = "アプリを開いて話している時に「これ見れる？」と言われた時や、話の流れで気になった時に、シャノンがカメラで1枚だけ見ます。見た時は「いま見ました」と小さな画像を表示します。写した画像は一度見るために送るだけで、端末にもシャノンのサーバーにも保存しません。アプリが画面に出ていない間は見ません。"
    public static let openSettingsTitle = "カメラの権限を設定で開く"
    public static let cueTitle = "いま見ました"
    public static let cueAccessibility = "シャノンがカメラでいま1枚見ました"

    public static func statusText(enabled: Bool, permission: ShannonMediaPermission, hasCamera: Bool) -> String {
        if !hasCamera { return "この端末にはカメラがありません" }
        if !enabled { return "見ません" }
        switch permission {
        case .granted: return "見てと言われた時と、気になった時に見ます"
        case .undetermined: return "最初に見る時に、カメラの許可を確認します"
        case .denied: return "カメラの権限がありません"
        }
    }
}
