import Foundation

/// One upcoming event exactly as `PUT /v1/calendar/upcoming` accepts it.
/// Notes, attendees and URLs have no field here, so they cannot be sent.
public struct ShannonCalendarEventDTO: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let start: String
    public let end: String
    public let allDay: Bool
    public let calendar: String?
    public let location: String?

    public init(
        id: String,
        title: String,
        start: String,
        end: String,
        allDay: Bool,
        calendar: String? = nil,
        location: String? = nil
    ) {
        self.id = id
        self.title = title
        self.start = start
        self.end = end
        self.allDay = allDay
        self.calendar = calendar
        self.location = location
    }
}

/// The bounded snapshot a device sends. The server replaces the device's previous snapshot with it.
public struct ShannonCalendarUpcomingRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let generatedAt: String
    public let timeZone: String
    public let windowStart: String
    public let windowEnd: String
    public let events: [ShannonCalendarEventDTO]

    public init(
        scopeKey: String,
        generatedAt: String,
        timeZone: String,
        windowStart: String,
        windowEnd: String,
        events: [ShannonCalendarEventDTO]
    ) {
        self.scopeKey = scopeKey
        self.generatedAt = generatedAt
        self.timeZone = timeZone
        self.windowStart = windowStart
        self.windowEnd = windowEnd
        self.events = events
    }
}

public struct ShannonCalendarUpcomingResponseDTO: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let stored: Int
    public let receivedAt: String

    public init(schemaVersion: Int = 1, stored: Int, receivedAt: String) {
        self.schemaVersion = schemaVersion
        self.stored = stored
        self.receivedAt = receivedAt
    }
}

/// Limits of the server contract. The client never sends more than these.
public enum ShannonCalendarSharingBounds {
    public static let maximumEvents = 300
    public static let maximumTitle = 200
    public static let maximumCalendar = 80
    public static let maximumLocation = 200
    public static let maximumID = 200
    public static let maximumBodyBytes = 256 * 1024
    /// One hour back so an event that is happening now is still known.
    public static let lookBehind: TimeInterval = 60 * 60
    public static let lookAhead: TimeInterval = 14 * 24 * 60 * 60
}

/// The paired connection a snapshot belongs to.
public struct ShannonCalendarSharingIdentity: Equatable, Sendable {
    public let scopeKey: String
    public let deviceID: String

    public init(scopeKey: String, deviceID: String) {
        self.scopeKey = scopeKey
        self.deviceID = deviceID
    }
}

public enum ShannonCalendarSharingError: Error, Equatable {
    /// No paired device credential. Nothing is sent with the build-time token.
    case notPaired
}
