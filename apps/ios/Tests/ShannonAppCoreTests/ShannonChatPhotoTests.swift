import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import ShannonAppCore

/// The Mac's photo for a text turn (roadmap A14): any image becomes a bounded JPEG without metadata.
final class ShannonChatPhotoTests: XCTestCase {
    func testLargeImageIsScaledToTheLongSideAndEncodedAsJPEG() throws {
        let photo = try ShannonChatPhoto.prepare(png(width: 3_000, height: 1_500))
        XCTAssertEqual(photo.width, ShannonChatPhoto.maximumSide)
        XCTAssertEqual(photo.height, 640)
        XCTAssertLessThanOrEqual(photo.jpegData.count, ShannonChatPhoto.maximumBytes)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(photo.jpegData as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
    }

    func testSmallImageKeepsItsSize() throws {
        let photo = try ShannonChatPhoto.prepare(png(width: 200, height: 100))
        XCTAssertEqual(photo.width, 200)
        XCTAssertEqual(photo.height, 100)
    }

    func testOrientationIsAppliedAndMetadataIsDropped() throws {
        // A 400×200 picture stored with orientation 6 (rotate 90° clockwise to show), a location and a camera.
        let properties: [CFString: Any] = [
            kCGImagePropertyOrientation: 6,
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 35.68, kCGImagePropertyGPSLatitudeRef: "N"],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "secret"],
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFModel: "Camera"],
        ]
        let photo = try ShannonChatPhoto.prepare(encoded(width: 400, height: 200, type: .jpeg, properties: properties))
        XCTAssertEqual(photo.width, 200)
        XCTAssertEqual(photo.height, 400)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(photo.jpegData as CFData, nil))
        let written = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        XCTAssertNil(written[kCGImagePropertyGPSDictionary])
        XCTAssertNil(written[kCGImagePropertyTIFFDictionary])
        let exif = written[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        XCTAssertNil(exif[kCGImagePropertyExifUserComment])
        XCTAssertEqual((written[kCGImagePropertyOrientation] as? Int) ?? 1, 1)
    }

    func testTransparencyBecomesWhite() throws {
        let photo = try ShannonChatPhoto.prepare(encoded(width: 40, height: 40, type: .png, opaque: false))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(photo.jpegData as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertGreaterThan(pixel[0], 240)
        XCTAssertGreaterThan(pixel[1], 240)
        XCTAssertGreaterThan(pixel[2], 240)
    }

    func testBytesThatAreNotAnImageAreRefused() {
        XCTAssertThrowsError(try ShannonChatPhoto.prepare(Data("not an image".utf8))) { error in
            XCTAssertEqual(error as? ShannonChatPhoto.Failure, .invalidImage)
        }
    }

    private func png(width: Int, height: Int) throws -> Data {
        try encoded(width: width, height: height, type: .png)
    }

    /// A filled picture (or, not opaque, a fully transparent one) encoded with the given properties.
    private func encoded(width: Int, height: Int, type: UTType, opaque: Bool = true, properties: [CFString: Any] = [:]) throws -> Data {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        if opaque {
            context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
}
