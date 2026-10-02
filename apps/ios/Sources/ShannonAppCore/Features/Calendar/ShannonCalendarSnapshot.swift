import Foundation

/// What the app may read from one calendar event. Notes, attendees and URLs are
/// deliberately absent: the reader never hands them to the rest of the app.
public struct ShannonCalendarSourceEvent: Equatable, Sendable {
    public let identifier: String
    public let title: String?
    public let start: Date
    public let end: Date
    public let isAllDay: Bool
    public let calendarTitle: String?
    public let location: String?
    /// True for an occurrence of a repeating event; its identifier is shared by every occurrence.
    public let isRecurring: Bool
    /// True when the owner declined the invitation or the event was cancelled.
    public let isDeclined: Bool

    public init(
        identifier: String,
        title: String?,
        start: Date,
        end: Date,
        isAllDay: Bool = false,
        calendarTitle: String? = nil,
        location: String? = nil,
        isRecurring: Bool = false,
        isDeclined: Bool = false
    ) {
        self.identifier = identifier
        self.title = title
        self.start = start
        self.end = end
        self.isAllDay = isAllDay
        self.calendarTitle = calendarTitle
        self.location = location
        self.isRecurring = isRecurring
        self.isDeclined = isDeclined
    }
}

public enum ShannonCalendarAuthorization: Equatable, Sendable {
    case notDetermined
    case granted
    /// Denied, restricted, or write-only: events cannot be read.
    case denied
}

/// The on-device calendar. EventKit implements it in the apps; tests inject a fixture.
public protocol ShannonCalendarEventSource: Sendable {
    func authorization() -> ShannonCalendarAuthorization
    /// Shows the system permission prompt if the owner has not decided yet.
    func requestAccess() async -> Bool
    func events(from start: Date, to end: Date) async -> [ShannonCalendarSourceEvent]
    /// Yields each time the calendar database changes.
    func changes() -> AsyncStream<Void>
}

/// Pure mapping from on-device events to the bounded server snapshot.
public enum ShannonCalendarSnapshotBuilder {
    public static let untitled = "（題名なし）"

    public static func window(now: Date) -> (start: Date, end: Date) {
        (
            now.addingTimeInterval(-ShannonCalendarSharingBounds.lookBehind),
            now.addingTimeInterval(ShannonCalendarSharingBounds.lookAhead)
        )
    }

    public static func request(
        scopeKey: String,
        events: [ShannonCalendarSourceEvent],
        now: Date,
        timeZone: TimeZone
    ) -> ShannonCalendarUpcomingRequestDTO {
        let window = window(now: now)
        return ShannonCalendarUpcomingRequestDTO(
            scopeKey: scopeKey,
            generatedAt: timestamp(now, timeZone: timeZone),
            timeZone: timeZone.identifier,
            windowStart: timestamp(window.start, timeZone: timeZone),
            windowEnd: timestamp(window.end, timeZone: timeZone),
            events: self.events(from: events, now: now, timeZone: timeZone)
        )
    }

    /// Events inside the window, declined ones removed, nearest first, at most 300.
    public static func events(
        from source: [ShannonCalendarSourceEvent],
        now: Date,
        timeZone: TimeZone
    ) -> [ShannonCalendarEventDTO] {
        let window = window(now: now)
        var seen = Set<String>()
        return source
            .filter { !$0.isDeclined && $0.end >= $0.start && $0.end >= window.start && $0.start <= window.end }
            .map { (event: $0, id: identifier(for: $0)) }
            .sorted { ($0.event.start, $0.id) < ($1.event.start, $1.id) }
            .filter { seen.insert($0.id).inserted }
            .prefix(ShannonCalendarSharingBounds.maximumEvents)
            .map { item in
                ShannonCalendarEventDTO(
                    id: item.id,
                    title: clipped(item.event.title, to: ShannonCalendarSharingBounds.maximumTitle) ?? untitled,
                    start: timestamp(item.event.start, timeZone: timeZone),
                    end: timestamp(item.event.end, timeZone: timeZone),
                    allDay: item.event.isAllDay,
                    calendar: clipped(item.event.calendarTitle, to: ShannonCalendarSharingBounds.maximumCalendar),
                    location: clipped(item.event.location, to: ShannonCalendarSharingBounds.maximumLocation)
                )
            }
    }

    /// Encodes the snapshot. If it would exceed the body limit, the farthest events are left out.
    public static func encode(_ request: ShannonCalendarUpcomingRequestDTO) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        var current = request
        var data = try encoder.encode(current)
        while data.count > ShannonCalendarSharingBounds.maximumBodyBytes, !current.events.isEmpty {
            let keep = min(current.events.count - 1, current.events.count * 9 / 10)
            current = ShannonCalendarUpcomingRequestDTO(
                scopeKey: current.scopeKey,
                generatedAt: current.generatedAt,
                timeZone: current.timeZone,
                windowStart: current.windowStart,
                windowEnd: current.windowEnd,
                events: Array(current.events.prefix(keep))
            )
            data = try encoder.encode(current)
        }
        return data
    }

    /// ISO 8601 with the numeric offset of `timeZone` (`Z` for UTC), no fractional seconds.
    public static func timestamp(_ date: Date, timeZone: TimeZone) -> String {
        date.formatted(Date.ISO8601FormatStyle(
            dateSeparator: .dash,
            dateTimeSeparator: .standard,
            timeSeparator: .colon,
            timeZoneSeparator: .colon,
            includingFractionalSeconds: false,
            timeZone: timeZone
        ))
    }

    /// A repeating event shares one identifier across occurrences, so the occurrence start is appended.
    static func identifier(for event: ShannonCalendarSourceEvent) -> String {
        let limit = ShannonCalendarSharingBounds.maximumID
        guard event.isRecurring else { return clip(event.identifier, to: limit) }
        let suffix = "@" + timestamp(event.start, timeZone: .gmt)
        return clip(event.identifier, to: limit - suffix.utf16.count) + suffix
    }

    /// Trimmed and clipped; nil when nothing is left.
    static func clipped(_ value: String?, to limit: Int) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return clip(trimmed, to: limit)
    }

    /// The server counts UTF-16 units, so the limit is applied to those without splitting a character.
    static func clip(_ value: String, to limit: Int) -> String {
        guard value.utf16.count > limit else { return value }
        var result = ""
        var used = 0
        for character in value {
            let width = character.utf16.count
            guard used + width <= limit else { break }
            result.append(character)
            used += width
        }
        return result
    }
}
