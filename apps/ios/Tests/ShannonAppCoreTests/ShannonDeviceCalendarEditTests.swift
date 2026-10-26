@preconcurrency import EventKit
import XCTest
@testable import ShannonAppCore

/// The pure parts of changing the owner's calendar on the device (`calendar.update_event`, `calendar.delete_event`, and the
/// times of `calendar.create_event` when an undo puts an event back). EventKit's store itself is not touched.
final class ShannonDeviceCalendarEditTests: XCTestCase {
    private func action(_ kind: String, _ payload: [String: ShannonJSONValue]) -> ShannonDeviceActionDTO {
        ShannonDeviceActionDTO(id: "A", kind: kind, payload: payload, requestedAt: "2026-10-26T01:00:00.000Z", expiresAt: "2026-10-26T07:00:00.000Z")
    }

    @MainActor
    func testTheAppSaysItCanChangeAndDeleteEvents() {
        XCTAssertTrue(ShannonDeviceActionModel.kinds.contains("calendar.update_event"))
        XCTAssertTrue(ShannonDeviceActionModel.kinds.contains("calendar.delete_event"))
        XCTAssertEqual(ShannonDeviceActionCode.changed.rawValue, "changed")
    }

    func testAnUndoPutsAnEventBackAtItsOwnInstants() throws {
        let times = try XCTUnwrap(ShannonDeviceEventKitWriter.eventTimes(action("calendar.create_event", [
            "title": .string("設計レビュー"), "startAt": .string("2026-11-04T05:00:00Z"), "endAt": .string("2026-11-04T06:00:00.000Z"),
        ])))
        XCTAssertEqual(times.0, ShannonDeviceActionClock.date("2026-11-04T05:00:00Z"))
        XCTAssertEqual(times.1, ShannonDeviceActionClock.date("2026-11-04T06:00:00Z"))
        XCTAssertFalse(times.2)
        // An all-day event ends on the last second of its day, as EventKit keeps it.
        let allDay = try XCTUnwrap(ShannonDeviceEventKitWriter.eventTimes(action("calendar.create_event", [
            "title": .string("文化の日"), "startAt": .string("2026-11-02T15:00:00Z"), "endAt": .string("2026-11-03T15:00:00Z"), "allDay": .bool(true),
        ])))
        XCTAssertEqual(allDay.1.timeIntervalSince(allDay.0), 86_399)
        XCTAssertTrue(allDay.2)
    }

    func testANewEventFromLocalWordsKeepsItsOldRules() throws {
        let hour = try XCTUnwrap(ShannonDeviceEventKitWriter.eventTimes(action("calendar.create_event", ["start": .string("2026-10-28T10:00")])))
        XCTAssertEqual(hour.1.timeIntervalSince(hour.0), 3_600)
        let day = try XCTUnwrap(ShannonDeviceEventKitWriter.eventTimes(action("calendar.create_event", ["start": .string("2026-10-28")])))
        XCTAssertTrue(day.2)
        XCTAssertNil(ShannonDeviceEventKitWriter.eventTimes(action("calendar.create_event", ["start": .string("tomorrow")])))
    }

    func testAChangeIsRefusedWhenTheEventIsNoLongerWhatWasShown() {
        let event = EKEvent(eventStore: EKEventStore())
        event.title = "設計レビュー"
        event.startDate = ShannonDeviceActionClock.date("2026-11-04T05:00:00Z")
        event.endDate = ShannonDeviceActionClock.date("2026-11-04T06:00:00Z")
        let shown: ShannonJSONValue = .object([
            "title": .string("設計レビュー"), "start": .string("2026-11-04T05:00:00.000Z"), "end": .string("2026-11-04T06:00:00.000Z"),
        ])
        XCTAssertTrue(ShannonDeviceEventKitWriter.matches(event, shown))
        XCTAssertTrue(ShannonDeviceEventKitWriter.matches(event, nil))
        event.startDate = ShannonDeviceActionClock.date("2026-11-04T06:00:00Z")
        XCTAssertFalse(ShannonDeviceEventKitWriter.matches(event, shown))
        event.startDate = ShannonDeviceActionClock.date("2026-11-04T05:00:00Z")
        event.title = "別の予定"
        XCTAssertFalse(ShannonDeviceEventKitWriter.matches(event, shown))
    }

    func testAChangeSetsOnlyTheFieldsItNamesAndReportsWhatWasThere() {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = "設計レビュー"
        event.location = "会議室A"
        event.startDate = ShannonDeviceActionClock.date("2026-11-04T05:00:00Z")
        event.endDate = ShannonDeviceActionClock.date("2026-11-04T06:00:00Z")
        guard case .object(let before) = ShannonDeviceEventKitWriter.fields(of: event) else { return XCTFail("fields are an object") }
        XCTAssertEqual(before["startAt"], .string("2026-11-04T05:00:00Z"))
        XCTAssertEqual(before["location"], .string("会議室A"))
        ShannonDeviceEventKitWriter.apply([
            "startAt": .string("2026-11-05T06:00:00.000Z"), "endAt": .string("2026-11-05T07:00:00.000Z"), "location": .string(""),
        ], to: event, in: store)
        XCTAssertEqual(event.title, "設計レビュー")
        XCTAssertNil(event.location)
        XCTAssertEqual(event.startDate, ShannonDeviceActionClock.date("2026-11-05T06:00:00Z"))
        XCTAssertEqual(event.endDate, ShannonDeviceActionClock.date("2026-11-05T07:00:00Z"))
    }
}
