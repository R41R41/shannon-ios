import XCTest
@testable import ShannonAppCore

final class ShannonExpressionAssetTests: XCTestCase {
    func testEveryExpressionHasABundledImage() {
        for expression in ShannonExpressionDTO.allCases {
            XCTAssertNotNil(
                ShannonExpressionAssets.url(for: expression),
                "Missing image for \(expression.rawValue)"
            )
        }
    }

    func testAssetNamesAreStableAndUnique() {
        let names = ShannonExpressionDTO.allCases.map(\.assetName)

        XCTAssertEqual(Set(names).count, ShannonExpressionDTO.allCases.count)
        XCTAssertEqual(ShannonExpressionDTO.neutral.assetName, "shannon-expression-neutral")
    }
}

