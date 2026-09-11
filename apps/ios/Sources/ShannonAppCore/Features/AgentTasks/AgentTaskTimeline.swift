import Foundation

public struct ShannonAgentPlanItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var title: String
    public var status: ShannonAgentPlanStatus

    public init(id: String, title: String, status: ShannonAgentPlanStatus) {
        self.id = id
        self.title = title
        self.status = status
    }
}

public enum ShannonAgentEventTone: String, Codable, Equatable, Sendable {
    case neutral
    case progress
    case success
    case warning
    case error
}

public enum ShannonAgentTimelineActivityKind: String, Codable, Equatable, Sendable {
    case command
}

public enum ShannonAgentTimelineActivityStatus: String, Codable, Equatable, Sendable {
    case running
    case completed
    case failed
}

public struct ShannonAgentTimelineActivity: Codable, Equatable, Sendable {
    public let kind: ShannonAgentTimelineActivityKind
    public let status: ShannonAgentTimelineActivityStatus

    public init(kind: ShannonAgentTimelineActivityKind, status: ShannonAgentTimelineActivityStatus) {
        self.kind = kind
        self.status = status
    }
}

public struct ShannonAgentTimelineEvent: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let sequence: Int
    public var title: String
    public var detail: String?
    public var occurredAt: Date
    public var tone: ShannonAgentEventTone
    public var activity: ShannonAgentTimelineActivity?

    public init(
        id: UUID = UUID(),
        sequence: Int,
        title: String,
        detail: String? = nil,
        occurredAt: Date = Date(),
        tone: ShannonAgentEventTone = .neutral,
        activity: ShannonAgentTimelineActivity? = nil
    ) {
        self.id = id
        self.sequence = sequence
        self.title = title
        self.detail = detail
        self.occurredAt = occurredAt
        self.tone = tone
        self.activity = activity
    }
}
