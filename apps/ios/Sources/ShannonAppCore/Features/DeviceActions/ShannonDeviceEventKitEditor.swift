@preconcurrency import EventKit
import Foundation

/// Changes or deletes one event the owner confirmed (`calendar.update_event`, `calendar.delete_event`;
/// `docs/device-actions-contract.md`, "Changing the calendar"). The server names the event by its EventKit identifier and,
/// for a repeating event, the start of the one occurrence; only that occurrence changes (`.thisEvent`). Before anything is
/// written the event must still have the title and times the owner was shown (`expect`), or the report is `changed`.
/// The report carries what the event was before, so that Shannon can put it back (`calendar.undo`).
extension ShannonDeviceEventKitWriter {
    func updateEvent(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
        guard case .object(let changes)? = action.payload["changes"] else { return .failed(.invalid) }
        guard await fullEventAccess() else { return .denied() }
        let store = store
        guard let event = Self.event(for: action, in: store) else { return .failed(.notFound) }
        guard Self.matches(event, action.payload["expect"]) else { return .failed(.changed) }
        let before = Self.fields(of: event)
        Self.apply(changes, to: event, in: store)
        guard event.endDate >= event.startDate else { return .failed(.invalid) }
        do {
            try store.save(event, span: .thisEvent, commit: true)
            let after: ShannonJSONValue = .object(["startAt": .string(Self.instant(event.startDate))])
            return .done(["id": .string(event.eventIdentifier ?? ""), "before": before, "after": after])
        } catch {
            return .failed(.failed)
        }
    }

    func deleteEvent(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
        guard await fullEventAccess() else { return .denied() }
        let store = store
        guard let event = Self.event(for: action, in: store) else { return .failed(.notFound) }
        guard Self.matches(event, action.payload["expect"]) else { return .failed(.changed) }
        let before = Self.fields(of: event)
        let identifier = event.eventIdentifier ?? ""
        do {
            try store.remove(event, span: .thisEvent, commit: true)
            return .done(["id": .string(identifier), "before": before])
        } catch {
            return .failed(.failed)
        }
    }

    /// Changing an event needs to read it: full access, asked for (or upgraded from write-only) the first time.
    private func fullEventAccess() async -> Bool {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return true
        case .notDetermined, .writeOnly: return (try? await store.requestFullAccessToEvents()) ?? false
        default: return false
        }
    }

    /// The event an action names: by its event identifier (or, after an undo of an addition, its calendar item identifier),
    /// and for a repeating event the occurrence that starts at `occurrenceStart`.
    static func event(for action: ShannonDeviceActionDTO, in store: EKEventStore) -> EKEvent? {
        guard let identifier = action.string("eventId") else { return nil }
        let byItem = store.calendarItem(withIdentifier: identifier) as? EKEvent
        let found = action.string("idKind") == "item" ? byItem ?? store.event(withIdentifier: identifier)
            : store.event(withIdentifier: identifier) ?? byItem
        guard let base = found else { return nil }
        let repeating = base.hasRecurrenceRules || base.isDetached || action.payload["recurring"]?.boolValue == true
        guard repeating, let occurrence = action.string("occurrenceStart").flatMap(ShannonDeviceActionClock.date) else { return base }
        let calendars = base.calendar.map { [$0] }
        let predicate = store.predicateForEvents(withStart: occurrence.addingTimeInterval(-60), end: occurrence.addingTimeInterval(60), calendars: calendars)
        return store.events(matching: predicate).first {
            $0.eventIdentifier == base.eventIdentifier && abs($0.startDate.timeIntervalSince(occurrence)) < 60
        }
    }

    /// Whether the event still has the title and times the owner was shown. No expectation (an undo of an addition) is no check.
    static func matches(_ event: EKEvent, _ expected: ShannonJSONValue?) -> Bool {
        guard case .object(let expect)? = expected else { return true }
        let title = ShannonCalendarSnapshotBuilder.clipped(event.title, to: ShannonCalendarSharingBounds.maximumTitle)
            ?? ShannonCalendarSnapshotBuilder.untitled
        if let shown = expect["title"]?.stringValue, shown != title, !(shown == "（題なし）" && title == ShannonCalendarSnapshotBuilder.untitled) {
            return false
        }
        for (key, date) in [("start", event.startDate), ("end", event.endDate)] {
            guard let text = expect[key]?.stringValue, let shown = ShannonDeviceActionClock.date(text), let date else { continue }
            if abs(shown.timeIntervalSince(date)) >= 60 { return false }
        }
        return true
    }

    /// The fields of a change: present keys are set, an empty location or note is removed.
    static func apply(_ changes: [String: ShannonJSONValue], to event: EKEvent, in store: EKEventStore) {
        if let title = changes["title"]?.stringValue, !title.isEmpty { event.title = title }
        if let allDay = changes["allDay"]?.boolValue { event.isAllDay = allDay }
        if let start = changes["startAt"]?.stringValue.flatMap(ShannonDeviceActionClock.date) { event.startDate = start }
        if let end = changes["endAt"]?.stringValue.flatMap(ShannonDeviceActionClock.date) {
            // The server sends the next midnight as the end of an all-day event; EventKit keeps the last second of the day.
            event.endDate = event.isAllDay ? max(event.startDate, end.addingTimeInterval(-1)) : end
        }
        if let location = changes["location"]?.stringValue { event.location = location.isEmpty ? nil : location }
        if let notes = changes["notes"]?.stringValue { event.notes = notes.isEmpty ? nil : notes }
        if let name = changes["calendar"]?.stringValue, let calendar = writableCalendar(named: name, in: store) { event.calendar = calendar }
    }

    /// What an event was, for the report: enough to put it back. Notes are clipped to 500 characters.
    static func fields(of event: EKEvent) -> ShannonJSONValue {
        var fields: [String: ShannonJSONValue] = [
            "title": .string(event.title ?? ""),
            "startAt": .string(instant(event.startDate)),
            "endAt": .string(instant(event.isAllDay ? event.endDate.addingTimeInterval(1) : event.endDate)),
            "allDay": .bool(event.isAllDay),
        ]
        if let location = ShannonCalendarSnapshotBuilder.clipped(event.location, to: 200) { fields["location"] = .string(location) }
        if let notes = ShannonCalendarSnapshotBuilder.clipped(event.notes, to: 500) { fields["notes"] = .string(notes) }
        if let calendar = event.calendar?.title { fields["calendar"] = .string(calendar) }
        return .object(fields)
    }

    static func instant(_ date: Date) -> String {
        ShannonCalendarSnapshotBuilder.timestamp(date, timeZone: .gmt)
    }
}
