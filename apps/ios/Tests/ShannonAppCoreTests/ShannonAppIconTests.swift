import XCTest
@testable import ShannonAppCore
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

final class ShannonAppIconTests: XCTestCase {
    func testOnlyApprovedIconLevelsAreSelectable() {
        XCTAssertEqual(ShannonAppIconChoice.allCases, [.level02, .level06, .level10])
        XCTAssertEqual(ShannonAppIconChoice.selectableChoices, [.level02, .level06, .level10])
    }

    func testLevel06IsDefaultAndUsesPrimaryIcon() {
        XCTAssertEqual(ShannonAppIconChoice.defaultChoice, .level06)
        XCTAssertNil(ShannonAppIconChoice.level06.alternateIconName)
    }

    func testOtherLevelsUseRegisteredAlternateIconNames() {
        XCTAssertEqual(ShannonAppIconChoice.level02.alternateIconName, "ShannonIconL02")
        XCTAssertEqual(ShannonAppIconChoice.level10.alternateIconName, "ShannonIconL10")
    }

    func testEverySelectableIconHasAUniqueBundledPreview() {
        let names = ShannonAppIconChoice.selectableChoices.map(\.previewAssetName)
        XCTAssertEqual(Set(names).count, 3)
        for assetName in names {
            assertPreviewCanBeDecoded(assetName)
        }
    }

    private func assertPreviewCanBeDecoded(
        _ assetName: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertNotNil(
            ShannonAppIconAssets.url(for: assetName),
            "Missing preview file for \(assetName)",
            file: file,
            line: line
        )
#if canImport(UIKit)
        XCTAssertNotNil(
            ShannonAppIconAssets.uiImage(for: assetName),
            "Preview is not a decodable image: \(assetName)",
            file: file,
            line: line
        )
#elseif canImport(AppKit)
        XCTAssertNotNil(
            ShannonAppIconAssets.nsImage(for: assetName),
            "Preview is not a decodable image: \(assetName)",
            file: file,
            line: line
        )
#endif
    }
}
