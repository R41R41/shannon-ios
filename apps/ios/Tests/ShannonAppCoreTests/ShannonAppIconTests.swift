import XCTest
@testable import ShannonAppCore
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

final class ShannonAppIconTests: XCTestCase {
    func testEverySelectableIconHasABundledVisualPreview() {
        assertPreviewCanBeDecoded(ShannonAppIconAssets.primaryLightPreviewAssetName)
        assertPreviewCanBeDecoded(ShannonAppIconAssets.primaryDarkPreviewAssetName)

        for choice in ShannonAppIconChoice.allCases {
            assertPreviewCanBeDecoded(choice.previewAssetName)
        }
    }

    func testPreviewAssetNamesAreUnique() {
        let names = ShannonAppIconChoice.allCases.map(\.previewAssetName)
        XCTAssertEqual(Set(names).count, names.count)
        XCTAssertEqual(ShannonAppIconChoice.light.previewAssetName, ShannonAppIconAssets.primaryLightPreviewAssetName)
    }

    func testEveryExpressionMapsToAnEmotionIcon() {
        let mapped = ShannonExpressionDTO.allCases.map(ShannonAppIconChoice.matching)

        XCTAssertEqual(mapped.count, ShannonExpressionDTO.allCases.count)
        XCTAssertTrue(mapped.allSatisfy(ShannonAppIconChoice.emotionChoices.contains))
        XCTAssertEqual(
            Set(mapped.map(\.rawValue)),
            Set(ShannonAppIconChoice.emotionChoices.filter { $0 != .sleeping }.map(\.rawValue))
        )
    }

    func testModeOffersAutomaticAppearanceLinkedAndManualSelection() {
        XCTAssertEqual(ShannonAppIconMode.allCases, [.automatic, .appearance, .manual])
    }

    func testManualChoicesContainAppearanceWaterlightThenShannonExpressions() {
        XCTAssertEqual(Array(ShannonAppIconChoice.manualChoices.prefix(3)), [.light, .dark, .shannon])
        XCTAssertEqual(Array(ShannonAppIconChoice.manualChoices.dropFirst(3)), ShannonAppIconChoice.emotionChoices)
        XCTAssertEqual(ShannonAppIconChoice.light.alternateIconName, "ShannonIconLight")
        XCTAssertEqual(ShannonAppIconChoice.dark.alternateIconName, "ShannonIconDark")
        XCTAssertEqual(ShannonAppIconChoice.shannon.alternateIconName, "ShannonIconWaterlight")
        XCTAssertFalse(ShannonAppIconChoice.emotionChoices.contains(.shannon))
        XCTAssertFalse(ShannonAppIconChoice.allCases.contains { $0.rawValue.contains("Compare") })
    }

    func testAppearanceMapsToDedicatedAlternateIcons() {
        XCTAssertEqual(ShannonAppIconAppearance.light.choice, .light)
        XCTAssertEqual(ShannonAppIconAppearance.dark.choice, .dark)
        XCTAssertEqual(ShannonAppIconChoice.light.previewAssetName, ShannonAppIconAssets.primaryLightPreviewAssetName)
        XCTAssertEqual(ShannonAppIconChoice.dark.previewAssetName, ShannonAppIconAssets.primaryDarkPreviewAssetName)
    }

    func testPrimaryExpressionMappingsRemainStable() {
        XCTAssertEqual(ShannonAppIconChoice.matching(.calm), .calm)
        XCTAssertEqual(ShannonAppIconChoice.matching(.joyful), .joyful)
        XCTAssertEqual(ShannonAppIconChoice.matching(.curious), .curious)
        XCTAssertEqual(ShannonAppIconChoice.matching(.sleepy), .sleepy)
        XCTAssertEqual(ShannonAppIconChoice.matching(.exasperated), .exasperated)
        XCTAssertEqual(ShannonAppIconChoice.matching(.excited), .excited)
        XCTAssertEqual(ShannonAppIconChoice.matching(.laughing), .laughing)
        XCTAssertEqual(ShannonAppIconChoice.matching(.tender), .tender)
        XCTAssertEqual(ShannonAppIconChoice.matching(.bashful), .bashful)
        XCTAssertEqual(ShannonAppIconChoice.matching(.determined), .determined)
    }

    func testTimePolicyUsesSleepingAndSleepyWindows() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))

        let sleeping = ShannonAppIconPolicy.decision(
            expression: .joyful,
            now: date(hour: 2, calendar: calendar),
            awakeUntil: nil,
            calendar: calendar,
            randomRoll: 0,
            randomIndex: 0,
            recentDayChoices: []
        )
        XCTAssertEqual(sleeping.choice, .sleeping)
        XCTAssertEqual(sleeping.timeState, .sleeping)

        let sleepyMorning = ShannonAppIconPolicy.decision(
            expression: .joyful,
            now: date(hour: 6, calendar: calendar),
            awakeUntil: nil,
            calendar: calendar,
            randomRoll: 0,
            randomIndex: 0,
            recentDayChoices: []
        )
        XCTAssertEqual(sleepyMorning.choice, .sleepy)

        let sleepyNight = ShannonAppIconPolicy.decision(
            expression: .joyful,
            now: date(hour: 23, calendar: calendar),
            awakeUntil: nil,
            calendar: calendar,
            randomRoll: 0,
            randomIndex: 0,
            recentDayChoices: []
        )
        XCTAssertEqual(sleepyNight.choice, .sleepy)
    }

    func testLateNightUseKeepsShannonSleepyUntilThirtyMinuteDeadline() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        let now = date(hour: 2, minute: 10, calendar: calendar)
        let awakeUntil = now.addingTimeInterval(30 * 60)
        let decision = ShannonAppIconPolicy.decision(
            expression: .calm,
            now: now,
            awakeUntil: awakeUntil,
            calendar: calendar,
            randomRoll: 0,
            randomIndex: 0,
            recentDayChoices: []
        )

        XCTAssertEqual(decision.choice, .sleepy)
        XCTAssertEqual(decision.nextRefreshAt, awakeUntil)
    }

    func testDaytimeRandomChoiceAvoidsRecentAndIncompatibleExpressions() {
        let choice = ShannonAppIconPolicy.daytimeChoice(
            expression: .sad,
            randomRoll: 0.95,
            randomIndex: 0,
            recentChoices: [.calm, .tender]
        )
        XCTAssertEqual(choice, .curious)
        XCTAssertNotEqual(choice, .laughing)
    }

    private func date(hour: Int, minute: Int = 0, calendar: Calendar) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 9, day: 2, hour: hour, minute: minute))!
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
