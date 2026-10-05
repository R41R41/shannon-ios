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
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              let scaled = ShannonAppLookEncoder.resized(image, maximumSide: maximumSide)
        else { throw Failure.invalidImage }
        for quality in [0.78, 0.66, 0.54, 0.42] {
            if let jpeg = ShannonAppLookEncoder.jpeg(scaled, quality: quality), jpeg.count <= maximumBytes {
                return ShannonChatPhoto(jpegData: jpeg, width: scaled.width, height: scaled.height)
            }
        }
        throw Failure.invalidImage
    }
}
