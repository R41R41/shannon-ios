import Foundation

public struct ShannonAgentTimelineEventDTO: Codable, Equatable, Sendable {
    public let id: String
    public let sequence: Int
    public let title: String
    public let detail: String?
    public let occurredAt: String
    public let tone: ShannonAgentEventTone
    public let activity: ShannonAgentTimelineActivity?
}

public struct ShannonAgentApprovalDTO: Codable, Equatable, Sendable {
    public let id: String
    public let externalRequestID: String
    public let kind: ShannonAgentApprovalKind
    public let title: String
    public let reason: String
    public let resource: String?
    public let requestedAt: String
}

public struct ShannonAgentChangeSummaryDTO: Codable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let summary: String
    public let additions: Int
    public let deletions: Int
}

public struct ShannonAgentTestResultDTO: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let status: ShannonAgentTestStatus
    public let detail: String?
}

public struct ShannonAgentTaskRemoteDTO: Codable, Equatable, Sendable {
    public let id: String
    public let conversationThreadID: String
    public let sourceMessageID: String?
    public let title: String
    public let goal: String
    public let status: ShannonAgentTaskStatus
    public let summary: String
    public let currentAction: String?
    public let plan: [ShannonAgentPlanItem]
    public let timeline: [ShannonAgentTimelineEventDTO]
    public let pendingApproval: ShannonAgentApprovalDTO?
    public let changes: [ShannonAgentChangeSummaryDTO]
    public let tests: [ShannonAgentTestResultDTO]
    public let createdAt: String
    public let updatedAt: String
    public let latestSequence: Int
}

public struct ShannonAgentTaskEnvelopeDTO: Codable, Equatable, Sendable {
    public let task: ShannonAgentTaskRemoteDTO
    public let created: Bool?
}

public struct ShannonAgentTaskListDTO: Codable, Equatable, Sendable {
    public let tasks: [ShannonAgentTaskRemoteDTO]
}

public struct ShannonAgentTaskCreateRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let taskId: String
    public let idempotencyKey: String
    public let conversationThreadID: String
    public let sourceMessageID: String?
    public let title: String
    public let goal: String
    public let summary: String
    public let plan: [ShannonAgentPlanItem]
    public let hostHint: String?
    public let projectHint: String?
}

public struct ShannonAgentTaskCommandRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let idempotencyKey: String
    public let type: String
    public let payload: [String: String]
}
