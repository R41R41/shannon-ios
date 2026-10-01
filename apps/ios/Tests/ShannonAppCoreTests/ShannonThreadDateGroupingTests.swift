import XCTest
@testable import ShannonAppCore

final class ShannonThreadDateGroupingTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        calendar.locale = Locale(identifier: "ja_JP")
        calendar.firstWeekday = 1 // Sunday
        return calendar
    }

    /// Thursday 2026-10-01 15:30 JST.
    private var now: Date { date("2026-10-01T15:30:00+09:00") }

    private func date(_ value: String) -> Date {
        ShannonThreadDateGrouping.date(from: value)!
    }

    private func thread(_ id: String, updatedAt: String) -> ChatThreadDTO {
        ChatThreadDTO(threadId: id, title: id, createdAt: updatedAt, updatedAt: updatedAt, messageCount: 3)
    }

    func testParsesServerTimestampsWithAndWithoutFractionalSeconds() {
        XCTAssertNotNil(ShannonThreadDateGrouping.date(from: "2026-10-01T06:30:00.123Z"))
        XCTAssertNotNil(ShannonThreadDateGrouping.date(from: "2026-10-01T06:30:00Z"))
        XCTAssertNil(ShannonThreadDateGrouping.date(from: "not a date"))
    }

    func testGroupsByCalendarDayAndWeek() {
        func group(_ value: String) -> ShannonThreadDateGroup {
            ShannonThreadDateGrouping.group(for: date(value), now: now, calendar: calendar)
        }
        XCTAssertEqual(group("2026-10-01T00:00:00+09:00"), .today)
        XCTAssertEqual(group("2026-09-30T23:59:00+09:00"), .yesterday)
        XCTAssertEqual(group("2026-09-30T00:00:00+09:00"), .yesterday)
        XCTAssertEqual(group("2026-09-29T12:00:00+09:00"), .thisWeek) // Tuesday
        XCTAssertEqual(group("2026-09-27T09:00:00+09:00"), .thisWeek) // Sunday, first day of week
        XCTAssertEqual(group("2026-09-26T21:00:00+09:00"), .earlier) // Saturday of last week
        XCTAssertEqual(group("2025-12-31T21:00:00+09:00"), .earlier)
    }

    func testFutureAndUnknownDatesAreHandledSafely() {
        let future = date("2026-10-02T09:00:00+09:00")
        XCTAssertEqual(ShannonThreadDateGrouping.group(for: future, now: now, calendar: calendar), .today)
        XCTAssertEqual(ShannonThreadDateGrouping.group(for: nil, now: now, calendar: calendar), .earlier)
        XCTAssertEqual(ShannonThreadDateGrouping.relativeLabel(for: nil, now: now, calendar: calendar), "更新日時不明")
    }

    func testSectionsKeepGroupOrderAndIncomingThreadOrder() {
        let threads = [
            thread("today-late", updatedAt: "2026-10-01T15:00:00+09:00"),
            thread("old", updatedAt: "2026-08-01T10:00:00+09:00"),
            thread("today-early", updatedAt: "2026-10-01T08:00:00+09:00"),
            thread("tuesday", updatedAt: "2026-09-29T10:00:00+09:00"),
            thread("broken", updatedAt: ""),
        ]
        let sections = ShannonThreadDateGrouping.sections(for: threads, now: now, calendar: calendar)
        XCTAssertEqual(sections.map(\.title), ["今日", "今週", "それ以前"])
        XCTAssertEqual(sections.map { $0.threads.map(\.threadId) }, [
            ["today-late", "today-early"],
            ["tuesday"],
            ["old", "broken"],
        ])
        XCTAssertTrue(ShannonThreadDateGrouping.sections(for: [], now: now, calendar: calendar).isEmpty)
    }

    func testRelativeLabels() {
        func label(_ value: String) -> String {
            ShannonThreadDateGrouping.relativeLabel(for: date(value), now: now, calendar: calendar)
        }
        XCTAssertEqual(label("2026-10-01T09:05:00+09:00"), "09:05")
        XCTAssertEqual(label("2026-10-01T16:25:00+09:00"), "16:25") // clock skew stays a time
        XCTAssertEqual(label("2026-09-30T20:00:00+09:00"), "昨日")
        XCTAssertEqual(label("2026-09-29T12:00:00+09:00"), "火曜日")
        XCTAssertEqual(label("2026-09-12T12:00:00+09:00"), "9/12")
        XCTAssertEqual(label("2025-12-31T12:00:00+09:00"), "2025/12/31")
    }

    func testRelativeLabelsUseTheCalendarTimeZone() {
        // 2026-09-30T16:00Z is 2026-10-01 01:00 in Tokyo.
        XCTAssertEqual(
            ShannonThreadDateGrouping.relativeLabel(for: date("2026-09-30T16:00:00Z"), now: now, calendar: calendar),
            "01:00"
        )
    }

    func testPreviewUsesPlainSingleParagraphText() {
        let preview = ShannonThreadDateGrouping.preview(
            lastMessageText: "**明日**の予定を\n\n  `整理`しました。",
            lastMessageDate: date("2026-10-01T15:00:00+09:00"),
            threadUpdatedAt: date("2026-10-01T15:00:00+09:00")
        )
        XCTAssertEqual(preview, "明日の予定を 整理しました。")
    }

    func testPreviewIsHiddenWhenMissingEmptyOrStale() {
        let updated = date("2026-10-01T15:00:00+09:00")
        XCTAssertNil(ShannonThreadDateGrouping.preview(lastMessageText: nil, lastMessageDate: updated, threadUpdatedAt: updated))
        XCTAssertNil(ShannonThreadDateGrouping.preview(lastMessageText: " \n ", lastMessageDate: updated, threadUpdatedAt: updated))
        XCTAssertNil(ShannonThreadDateGrouping.preview(
            lastMessageText: "古いキャッシュ",
            lastMessageDate: date("2026-10-01T14:00:00+09:00"),
            threadUpdatedAt: updated
        ))
        XCTAssertEqual(ShannonThreadDateGrouping.preview(
            lastMessageText: "少しだけ前",
            lastMessageDate: updated.addingTimeInterval(-60),
            threadUpdatedAt: updated
        ), "少しだけ前")
    }

    func testPreviewIsBoundedInLength() {
        let preview = ShannonThreadDateGrouping.preview(
            lastMessageText: String(repeating: "あ", count: 500),
            lastMessageDate: now,
            threadUpdatedAt: nil
        )
        XCTAssertEqual(preview?.count, ShannonThreadDateGrouping.previewCharacterLimit)
    }

    func testWorkTileAnnouncesItsCount() {
        XCTAssertEqual(ShannonThreadListDestination(title: "作業", symbol: "x", badge: 1, action: {}).accessibilityLabel, "作業、1件")
        XCTAssertEqual(ShannonThreadListDestination(title: "作業", symbol: "x", badge: 0, action: {}).accessibilityLabel, "作業")
        XCTAssertEqual(ShannonThreadListDestination(title: "設定", symbol: "x", badge: nil, action: {}).accessibilityLabel, "設定")
    }
}
