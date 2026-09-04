import XCTest
@testable import ShannonAppCore

final class ShannonAppIconTests: XCTestCase {
    func testEveryExpressionMapsToAnEmotionIcon() {
        let mapped = ShannonExpressionDTO.allCases.map(ShannonAppIconChoice.matching)

        XCTAssertEqual(mapped.count, ShannonExpressionDTO.allCases.count)
        XCTAssertTrue(mapped.allSatisfy(ShannonAppIconChoice.allCases.contains))
        XCTAssertEqual(
            Set(mapped.map(\.rawValue)),
            Set(ShannonAppIconChoice.allCases.filter { $0 != .sleeping }.map(\.rawValue))
        )
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
}
