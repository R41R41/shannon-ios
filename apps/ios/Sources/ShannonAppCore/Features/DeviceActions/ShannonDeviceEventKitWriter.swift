@preconcurrency import EventKit
import Foundation

/// Adds what Shannon was asked for to the owner's own Reminders and Calendar (`reminder.create`, `calendar.create_event`),
/// and changes or deletes an event he confirmed (`calendar.update_event`, `calendar.delete_event`, in
/// `ShannonDeviceEventKitEditor.swift`). Access is asked the first time it is needed: full access to reminders, write-only
/// access to events for adding one unless the app already reads the calendar for sharing, and full access to change one.
final class ShannonDeviceEventKitWriter: @unchecked Sendable {
    private let lock = NSLock()
    private var cachedStore: EKEventStore?

    /// Created only when an action needs it, as `ShannonEventKitCalendarSource` does.
    var store: EKEventStore {
        lock.withLock {
            if let cachedStore { return cachedStore }
            let created = EKEventStore()
            cachedStore = created
            return created
        }
    }

    func createReminder(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
        guard let title = action.string("title") else { return .failed(.invalid) }
        guard await reminderAccess() else { return .denied() }
        let store = store
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.notes = action.string("notes")
        guard let calendar = store.defaultCalendarForNewReminders() else { return .failed(.unavailable) }
        reminder.calendar = calendar
        if let due = Self.dueDate(action) {
            if due < Date() { return .failed(.past) }
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            reminder.addAlarm(EKAlarm(absoluteDate: due))
        }
        do {
            try store.save(reminder, commit: true)
            return .done(["id": .string(reminder.calendarItemIdentifier)])
        } catch {
            return .failed(.failed)
        }
    }

    func createEvent(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
        guard let title = action.string("title"), let times = Self.eventTimes(action) else { return .failed(.invalid) }
        let (start, end, allDay) = times
        guard await eventAccess() else { return .denied() }
        let store = store
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = max(start, end)
        event.isAllDay = allDay
        event.location = action.string("location")
        event.notes = action.string("notes")
        // A calendar he named (an undo puts an event back where it was); otherwise the default one.
        guard let calendar = action.string("calendar").flatMap({ Self.writableCalendar(named: $0, in: store) })
            ?? store.defaultCalendarForNewEvents else { return .failed(.unavailable) }
        event.calendar = calendar
        do {
            try store.save(event, span: .thisEvent, commit: true)
            return .done(["id": .string(event.calendarItemIdentifier)])
        } catch {
            return .failed(.failed)
        }
    }

    private func reminderAccess() async -> Bool {
        switch EKEventStore.authorizationStatus(for: .reminder) {
        case .fullAccess: return true
        case .notDetermined: return (try? await store.requestFullAccessToReminders()) ?? false
        default: return false
        }
    }

    private func eventAccess() async -> Bool {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess, .writeOnly: return true
        case .notDetermined: return (try? await store.requestWriteOnlyAccessToEvents()) ?? false
        default: return false
        }
    }

    /// When a new event begins and ends: absolute times (`startAt`, `endAt`, from an undo), or the owner's local
    /// `start` with `end` or `durationMinutes` (an hour by default; a day for a date alone).
    static func eventTimes(_ action: ShannonDeviceActionDTO) -> (Date, Date, Bool)? {
        if let startAt = action.string("startAt").flatMap(ShannonDeviceActionClock.date) {
            let allDay = action.payload["allDay"]?.boolValue ?? false
            let endAt = action.string("endAt").flatMap(ShannonDeviceActionClock.date) ?? startAt.addingTimeInterval(3_600)
            return (startAt, allDay ? max(startAt, endAt.addingTimeInterval(-1)) : endAt, allDay)
        }
        guard let startText = action.string("start"), let start = localDate(startText) else { return nil }
        let allDay = action.payload["allDay"]?.boolValue ?? (startText.count == 10)
        if let endText = action.string("end"), let parsed = localDate(endText) { return (start, parsed, allDay) }
        if let minutes = action.number("durationMinutes") { return (start, start.addingTimeInterval(minutes * 60), allDay) }
        return (start, allDay ? start : start.addingTimeInterval(3_600), allDay)
    }

    /// A calendar of this device that takes changes, by its exact name.
    static func writableCalendar(named name: String, in store: EKEventStore) -> EKCalendar? {
        store.calendars(for: .event).first { $0.title == name && $0.allowsContentModifications }
    }

    /// `due` is the owner's local wall time (YYYY-MM-DDTHH:mm); `dueAt` an absolute time the server computed.
    static func dueDate(_ action: ShannonDeviceActionDTO) -> Date? {
        if let dueAt = action.string("dueAt") { return ShannonDeviceActionClock.date(dueAt) }
        return action.string("due").flatMap(localDate)
    }

    /// `YYYY-MM-DDTHH:mm` or `YYYY-MM-DD` in this device's calendar and time zone.
    static func localDate(_ text: String) -> Date? {
        let parts = text.split(whereSeparator: { $0 == "-" || $0 == "T" || $0 == ":" }).compactMap { Int($0) }
        guard parts.count == 3 || parts.count == 5 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = parts.count == 5 ? parts[3] : 0
        components.minute = parts.count == 5 ? parts[4] : 0
        return Calendar.current.date(from: components)
    }
}

/// The server's ISO 8601 times (with milliseconds).
enum ShannonDeviceActionClock {
    static func date(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}
