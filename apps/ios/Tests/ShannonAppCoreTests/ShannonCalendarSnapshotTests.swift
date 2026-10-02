import XCTest
@testable import ShannonAppCore

final class ShannonCalendarSnapshotTests: XCTestCase {
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    /// 2026-10-02T09:00:00+09:00
    private let now = Date(timeIntervalSince1970: 1_790_899_200)

    private func event(
        _ identifier: String,
        title: String? = "予定",
        startsIn hours: Double,
        lasts duration: Double = 1,
        allDay: Bool = false,
        calendar: String? = "仕事",
        location: String? = nil,
        recurring: Bool = false,
        declined: Bool = false
    ) -> ShannonCalendarSourceEvent {
        ShannonCalendarSourceEvent(
            identifier: identifier,
            title: title,
            start: now.addingTimeInterval(hours * 3_600),
            end: now.addingTimeInterval((hours + duration) * 3_600),
            isAllDay: allDay,
            calendarTitle: calendar,
            location: location,
            isRecurring: recurring,
            isDeclined: declined
        )
    }

    private func mapped(_ events: [ShannonCalendarSourceEvent]) -> [ShannonCalendarEventDTO] {
        ShannonCalendarSnapshotBuilder.events(from: events, now: now, timeZone: tokyo)
    }

    func testTheFixtureMomentIsWhatTheTestsAssume() {
        XCTAssertEqual(ShannonCalendarSnapshotBuilder.timestamp(now, timeZone: tokyo), "2026-10-02T09:00:00+09:00")
        XCTAssertEqual(ShannonCalendarSnapshotBuilder.timestamp(now, timeZone: .gmt), "2026-10-02T00:00:00Z")
    }

    func testMapsAnEventToTheContractFields() {
        let events = mapped([event("E1", title: "  歯医者 \n", startsIn: 2, location: " 駅前クリニック ")])
        XCTAssertEqual(events, [ShannonCalendarEventDTO(
            id: "E1",
            title: "歯医者",
            start: "2026-10-02T11:00:00+09:00",
            end: "2026-10-02T12:00:00+09:00",
            allDay: false,
            calendar: "仕事",
            location: "駅前クリニック"
        )])
    }

    func testRecurringOccurrencesGetTheirStartInTheIdentifier() {
        let events = mapped([
            event("R1", startsIn: 24, recurring: true),
            event("R1", startsIn: 48, recurring: true),
            event("S1", startsIn: 30),
        ])
        XCTAssertEqual(events.map(\.id), ["R1@2026-10-03T00:00:00Z", "S1", "R1@2026-10-04T00:00:00Z"])
        XCTAssertEqual(Set(events.map(\.id)).count, 3)
    }

    func testAllDayEventsAreIncludedAndFlagged() {
        let events = mapped([event("A1", title: "祝日", startsIn: 15, lasts: 23.99, allDay: true)])
        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].allDay)
        XCTAssertEqual(events[0].start, "2026-10-03T00:00:00+09:00")
    }

    func testDeclinedEventsAreSkipped() {
        let events = mapped([event("D1", startsIn: 1, declined: true), event("K1", startsIn: 2)])
        XCTAssertEqual(events.map(\.id), ["K1"])
    }

    func testOnlyEventsTouchingTheWindowAreKept() {
        let events = mapped([
            event("ended-long-ago", startsIn: -5),
            event("just-ended", startsIn: -1.5),
            event("ongoing", startsIn: -3, lasts: 4),
            event("last-day", startsIn: 14 * 24 - 1),
            event("beyond", startsIn: 14 * 24 + 1),
        ])
        XCTAssertEqual(events.map(\.id), ["ongoing", "just-ended", "last-day"])
        let window = ShannonCalendarSnapshotBuilder.window(now: now)
        XCTAssertEqual(window.start, now.addingTimeInterval(-3_600))
        XCTAssertEqual(window.end, now.addingTimeInterval(14 * 86_400))
        XCTAssertLessThanOrEqual(window.end.timeIntervalSince(window.start), 31 * 86_400)
    }

    func testTextIsClippedToTheServerBounds() {
        let events = mapped([event(
            String(repeating: "i", count: 260),
            title: String(repeating: "題", count: 250),
            startsIn: 1,
            calendar: String(repeating: "暦", count: 100),
            location: String(repeating: "所", count: 250),
            recurring: true
        )])
        XCTAssertEqual(events[0].title.utf16.count, 200)
        XCTAssertEqual(events[0].calendar?.utf16.count, 80)
        XCTAssertEqual(events[0].location?.utf16.count, 200)
        XCTAssertEqual(events[0].id.utf16.count, 200)
        XCTAssertTrue(events[0].id.hasSuffix("@2026-10-02T01:00:00Z"))
    }

    func testClippingCountsUTF16UnitsAndNeverSplitsACharacter() {
        let clipped = ShannonCalendarSnapshotBuilder.clip(String(repeating: "🎉", count: 150), to: 199)
        XCTAssertEqual(clipped.count, 99)
        XCTAssertEqual(clipped.utf16.count, 198)
    }

    func testEmptyTitleCalendarAndLocationAreHandled() {
        let events = mapped([event("E1", title: "   ", startsIn: 1, calendar: nil, location: "  ")])
        XCTAssertEqual(events[0].title, "（題名なし）")
        XCTAssertNil(events[0].calendar)
        XCTAssertNil(events[0].location)
    }

    func testSortsByStartAndKeepsTheNearestThreeHundred() {
        let source = (0..<320).reversed().map { event("E\($0)", startsIn: Double($0) + 1) }
        let events = mapped(source)
        XCTAssertEqual(events.count, 300)
        XCTAssertEqual(events.first?.id, "E0")
        XCTAssertEqual(events.last?.id, "E299")
        XCTAssertEqual(events.map(\.start), events.map(\.start).sorted())
    }

    func testRequestEncodingMatchesTheContractExactly() throws {
        let request = ShannonCalendarSnapshotBuilder.request(
            scopeKey: "owner-a",
            events: [
                event("E1", title: "歯医者", startsIn: 2, location: "駅前"),
                event("E2", title: "移動", startsIn: 3, calendar: nil),
            ],
            now: now,
            timeZone: tokyo
        )
        let data = try ShannonCalendarSnapshotBuilder.encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["scopeKey", "generatedAt", "timeZone", "windowStart", "windowEnd", "events"])
        XCTAssertEqual(object["scopeKey"] as? String, "owner-a")
        XCTAssertEqual(object["generatedAt"] as? String, "2026-10-02T09:00:00+09:00")
        XCTAssertEqual(object["timeZone"] as? String, "Asia/Tokyo")
        XCTAssertEqual(object["windowStart"] as? String, "2026-10-02T08:00:00+09:00")
        XCTAssertEqual(object["windowEnd"] as? String, "2026-10-16T09:00:00+09:00")
        let events = try XCTUnwrap(object["events"] as? [[String: Any]])
        XCTAssertEqual(Set(events[0].keys), ["id", "title", "start", "end", "allDay", "calendar", "location"])
        XCTAssertEqual(Set(events[1].keys), ["id", "title", "start", "end", "allDay"])
        XCTAssertEqual(events[0]["allDay"] as? Bool, false)
        XCTAssertEqual(events[0]["start"] as? String, "2026-10-02T11:00:00+09:00")
        let pattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$"#
        for value in [object["generatedAt"], object["windowStart"], object["windowEnd"], events[0]["start"], events[0]["end"]] {
            XCTAssertNotNil((value as? String)?.range(of: pattern, options: .regularExpression))
        }
        XCTAssertEqual(try JSONDecoder().decode(ShannonCalendarUpcomingRequestDTO.self, from: data), request)
    }

    func testEncodingLeavesOutTheFarthestEventsWhenTheBodyWouldBeTooLarge() throws {
        let source = (0..<300).map {
            event(
                String(repeating: "識", count: 150) + "\($0)",
                title: String(repeating: "題", count: 200),
                startsIn: Double($0) + 1,
                calendar: String(repeating: "暦", count: 80),
                location: String(repeating: "所", count: 200)
            )
        }
        let request = ShannonCalendarSnapshotBuilder.request(scopeKey: "owner", events: source, now: now, timeZone: tokyo)
        XCTAssertEqual(request.events.count, 300)
        let data = try ShannonCalendarSnapshotBuilder.encode(request)
        XCTAssertLessThanOrEqual(data.count, 256 * 1024)
        let sent = try JSONDecoder().decode(ShannonCalendarUpcomingRequestDTO.self, from: data)
        XCTAssertLessThan(sent.events.count, 300)
        XCTAssertGreaterThan(sent.events.count, 100)
        XCTAssertEqual(sent.events, Array(request.events.prefix(sent.events.count)))
    }

    // MARK: Sync gate and wording

    func testGateAlwaysSendsOnSwitchLaunchAndChangeButSpacesForegroundAndTimer() {
        var gate = ShannonCalendarSyncGate(periodicInterval: ShannonCalendarSyncGate.phoneInterval)
        for trigger in [ShannonCalendarSyncTrigger.enabled, .launch, .foreground, .storeChanged, .periodic] {
            XCTAssertTrue(gate.allows(trigger, now: now))
        }
        gate.record(now)
        let soon = now.addingTimeInterval(20)
        XCTAssertTrue(gate.allows(.enabled, now: soon))
        XCTAssertTrue(gate.allows(.launch, now: soon))
        XCTAssertTrue(gate.allows(.storeChanged, now: soon))
        XCTAssertFalse(gate.allows(.foreground, now: soon))
        XCTAssertFalse(gate.allows(.periodic, now: soon))
        XCTAssertTrue(gate.allows(.foreground, now: now.addingTimeInterval(60)))
        XCTAssertFalse(gate.allows(.periodic, now: now.addingTimeInterval(14 * 60)))
        XCTAssertTrue(gate.allows(.periodic, now: now.addingTimeInterval(15 * 60)))
        var mac = ShannonCalendarSyncGate(periodicInterval: ShannonCalendarSyncGate.macInterval)
        mac.record(now)
        XCTAssertFalse(mac.allows(.periodic, now: now.addingTimeInterval(15 * 60)))
        XCTAssertTrue(mac.allows(.periodic, now: now.addingTimeInterval(30 * 60)))
    }

    func testStatusWording() {
        let text = { (status: ShannonCalendarSharingStatus) in
            ShannonCalendarSharingCopy.statusText(status, timeZone: self.tokyo)
        }
        XCTAssertEqual(text(.off), "送っていません")
        XCTAssertEqual(text(.needsPermission), "権限がありません")
        XCTAssertEqual(text(.unsupported), "サーバーが未対応です。対応したら自動で送ります")
        XCTAssertEqual(text(.sent(at: now, count: 12)), "最終送信 10月2日 09:00・12件")
        XCTAssertEqual(text(.failed(lastSentAt: nil, count: 0)), "送れませんでした。次の機会にもう一度送ります")
        XCTAssertEqual(ShannonCalendarSharingCopy.toggleTitle, "カレンダーの予定をシャノンに伝える")
        for phrase in ["題名・時刻・場所・カレンダー名", "14日ぶん", "声をかけたり答えたりするため", "サーバーから削除します"] {
            XCTAssertTrue(ShannonCalendarSharingCopy.explanation.contains(phrase), phrase)
        }
        XCTAssertEqual(ShannonCalendarSharingStatus.designPreview(named: "permission"), .needsPermission)
        XCTAssertNil(ShannonCalendarSharingStatus.designPreview(named: nil))
    }
}
