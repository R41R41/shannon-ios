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

    func testBytesThatAreNotAnImageAreRefused() {
        XCTAssertThrowsError(try ShannonChatPhoto.prepare(Data("not an image".utf8))) { error in
            XCTAssertEqual(error as? ShannonChatPhoto.Failure, .invalidImage)
        }
    }

    private func png(width: Int, height: Int) throws -> Data {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
}
