import Foundation
import ImageIO

/// A photo to send with a text turn, prepared on any Apple platform from the bytes of an image
/// (a Photos pick or an image file on the Mac): the long side at most 1,280 pixels, JPEG, at most
/// 2.8 MB, no metadata (the same bounds as the iPhone's photo). Nothing is written to disk.
public struct ShannonChatPhoto: Equatable, Sendable {
    public let jpegData: Data
    public let width: Int
    public let height: Int

    public static let maximumSide = 1_280
    public static let maximumBytes = 2_800_000
    /// What is read at most before the image is decoded.
    public static let maximumSourceBytes = 30 * 1_024 * 1_024

    public enum Failure: LocalizedError, Equatable {
        case tooLarge
        case invalidImage

        public var errorDescription: String? {
            switch self {
            case .tooLarge: "この写真は大きすぎます。別の写真を選んでください。"
            case .invalidImage: "写真を共有用に準備できませんでした。別の写真を選んでください。"
            }
        }
    }

    public static func prepare(_ data: Data) throws -> ShannonChatPhoto {
        guard data.count <= maximumSourceBytes else { throw Failure.tooLarge }
        // A thumbnail at the final size: the full image is never decoded, and the EXIF orientation is applied.
        let options = [
            kCGImageSourceThumbnailMaxPixelSize: maximumSide,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options),
              let flattened = flattened(thumbnail)
        else { throw Failure.invalidImage }
        for quality in [0.78, 0.66, 0.54, 0.42] {
            if let jpeg = ShannonAppLookEncoder.jpeg(flattened, quality: quality), jpeg.count <= maximumBytes {
                return ShannonChatPhoto(jpegData: jpeg, width: flattened.width, height: flattened.height)
            }
        }
        throw Failure.invalidImage
    }

    /// Redraws the picture as a bare opaque bitmap: no metadata survives, and transparency becomes white.
    static func flattened(_ image: CGImage) -> CGImage? {
        guard image.width > 0, image.height > 0,
              let context = CGContext(
                data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
              ) else { return nil }
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(bounds)
        context.interpolationQuality = .high
        context.draw(image, in: bounds)
        return context.makeImage()
    }
}
