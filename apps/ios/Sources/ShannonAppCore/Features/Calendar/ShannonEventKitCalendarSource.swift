@preconcurrency import EventKit
import Foundation

/// Reads the owner's calendars through EventKit, including accounts (such as
/// Google Calendar) that were added to the system. The store is created only
/// when access is requested or events are read, never while sharing is off.
public final class ShannonEventKitCalendarSource: ShannonCalendarEventSource, @unchecked Sendable {
    private let lock = NSLock()
    private var cachedStore: EKEventStore?

    public init() {}

    public func authorization() -> ShannonCalendarAuthorization {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .notDetermined: .notDetermined
        case .fullAccess: .granted
        default: .denied
        }
    }

    public func requestAccess() async -> Bool {
        (try? await store().requestFullAccessToEvents()) ?? false
    }

    public func events(from start: Date, to end: Date) async -> [ShannonCalendarSourceEvent] {
        guard authorization() == .granted else { return [] }
        let store = store()
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate).compactMap(Self.sourceEvent)
    }

    public func changes() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let task = Task {
                for await _ in NotificationCenter.default.notifications(named: .EKEventStoreChanged) {
                    continuation.yield()
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func store() -> EKEventStore {
        lock.withLock {
            if let cachedStore { return cachedStore }
            let created = EKEventStore()
            cachedStore = created
            return created
        }
    }

    /// A participant's name, or the address of the invitation when the calendar has no name for them.
    private static func attendeeName(_ participant: EKParticipant) -> String? {
        if let name = participant.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        let address = participant.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
        return address.isEmpty ? nil : address
    }

    /// Copies only the fields of the server contract out of EventKit.
    private static func sourceEvent(_ event: EKEvent) -> ShannonCalendarSourceEvent? {
        guard let identifier = event.eventIdentifier, let start = event.startDate, let end = event.endDate else {
            return nil
        }
        let declined = event.status == .canceled
            || event.attendees?.contains { $0.isCurrentUser && $0.participantStatus == .declined } == true
        return ShannonCalendarSourceEvent(
            identifier: identifier,
            title: event.title,
            start: start,
            end: end,
            isAllDay: event.isAllDay,
            calendarTitle: event.calendar?.title,
            location: event.location,
            isRecurring: event.hasRecurrenceRules || event.isDetached,
            isDeclined: declined,
            attendees: (event.attendees ?? []).filter { !$0.isCurrentUser }.compactMap(Self.attendeeName)
        )
    }
}
