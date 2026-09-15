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
        XCTAssertEqual(ShannonAppIconChoice.level02.alternateIconName, "ShannonL02")
        XCTAssertEqual(ShannonAppIconChoice.level10.alternateIconName, "ShannonL10")
    }

    func testStableStoredChoicesAndPreviousAlternateNamesRemainCompatible() {
        XCTAssertEqual(ShannonAppIconChoice(rawValue: "ShannonIconL02"), .level02)
        XCTAssertEqual(ShannonAppIconChoice(rawValue: "ShannonIconL06"), .level06)
        XCTAssertEqual(ShannonAppIconChoice(rawValue: "ShannonIconL10"), .level10)
        XCTAssertEqual(ShannonAppIconChoice.resolvingAlternateIconName("ShannonIconL02"), .level02)
        XCTAssertEqual(ShannonAppIconChoice.resolvingAlternateIconName("ShannonIconL10"), .level10)
    }

    func testUnknownAndUnsetIconValuesFallBackToLevel06() {
        XCTAssertEqual(ShannonAppIconChoice.resolvingAlternateIconName(nil), .level06)
        XCTAssertEqual(ShannonAppIconChoice.resolvingAlternateIconName("retired-icon"), .level06)
    }

    @MainActor
    func testStoredSelectionSurvivesModelRecreationAndUnknownValueMigratesToLevel06() {
        let suiteName = "ShannonAppIconTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(ShannonAppIconChoice.level02.rawValue, forKey: ShannonAppIconModel.Keys.selectedChoice)
        XCTAssertEqual(
            ShannonAppIconModel(defaults: defaults, activeAlternateIconName: "ShannonL02").selectedChoice,
            .level02
        )

        defaults.set("retired-icon", forKey: ShannonAppIconModel.Keys.selectedChoice)
        let migrated = ShannonAppIconModel(defaults: defaults, activeAlternateIconName: nil)
        XCTAssertEqual(migrated.selectedChoice, .level06)
        XCTAssertEqual(
            defaults.string(forKey: ShannonAppIconModel.Keys.selectedChoice),
            ShannonAppIconChoice.level06.rawValue
        )
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
