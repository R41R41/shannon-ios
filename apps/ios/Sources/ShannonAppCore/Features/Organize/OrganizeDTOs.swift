import Foundation

public enum ShannonOrganizeDecisionDTO: String, Codable, Equatable, Sendable {
    case proposed, accepted, rejected, deferred
}

public enum ShannonOrganizeDestinationStatusDTO: String, Codable, Equatable, Sendable {
    case pending, applied, failed
}

public enum ShannonOrganizeSessionStateDTO: String, Codable, Equatable, Sendable {
    case readyForReview = "ready_for_review"
    case partiallyApplied = "partially_applied"
    case applied
}

public enum ShannonOrganizeOperationDTO: String, Codable, Equatable, Hashable, Sendable {
    case create, update
}

public enum ShannonOrganizeUpdateFieldDTO: String, Codable, Equatable, Hashable, Sendable {
    case title, details, projectIds
}

public struct ShannonVoyagerTaskProjectionDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let details: String
    public let status: String
    public let projectIds: [String]
    public let revision: Int
    public let updatedAt: String

    public init(id: String, title: String, details: String, status: String, projectIds: [String], revision: Int, updatedAt: String) {
        self.id = id
        self.title = title
        self.details = details
        self.status = status
        self.projectIds = projectIds
        self.revision = revision
        self.updatedAt = updatedAt
    }
}

public struct ShannonVoyagerProjectProjectionDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let revision: Int
    public let updatedAt: String

    public init(id: String, title: String, revision: Int, updatedAt: String) {
        self.id = id
        self.title = title
        self.revision = revision
        self.updatedAt = updatedAt
    }
}

public struct ShannonVoyagerTaskProjectionListDTO: Codable, Equatable, Sendable {
    public let items: [ShannonVoyagerTaskProjectionDTO]
}

public struct ShannonVoyagerProjectProjectionListDTO: Codable, Equatable, Sendable {
    public let items: [ShannonVoyagerProjectProjectionDTO]
}

public struct ShannonVoyagerTaskReferenceDTO: Codable, Equatable, Identifiable, Sendable {
    public var id: String { resourceId }
    public let system: String
    public let resourceType: String
    public let resourceId: String
    public let title: String
    public let summary: String?
    public let updatedAt: String
    public let href: String?
}

public struct ShannonOrganizeItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let details: String
    public let operation: ShannonOrganizeOperationDTO?
    public let target: ShannonVoyagerTaskProjectionDTO?
    public let projectIds: [String]?
    public let targetQuery: String?
    public let updateFields: [ShannonOrganizeUpdateFieldDTO]?
    public let projectSelectionRequired: Bool?
    public let decision: ShannonOrganizeDecisionDTO
    public let destinationStatus: ShannonOrganizeDestinationStatusDTO
    public let requestId: String
    public let idempotencyKey: String
    public let result: ShannonVoyagerTaskReferenceDTO?
    public let errorCode: String?

    public init(
        id: String,
        title: String,
        details: String,
        operation: ShannonOrganizeOperationDTO? = nil,
        target: ShannonVoyagerTaskProjectionDTO? = nil,
        projectIds: [String]? = nil,
        targetQuery: String? = nil,
        updateFields: [ShannonOrganizeUpdateFieldDTO]? = nil,
        projectSelectionRequired: Bool? = nil,
        decision: ShannonOrganizeDecisionDTO,
        destinationStatus: ShannonOrganizeDestinationStatusDTO,
        requestId: String,
        idempotencyKey: String,
        result: ShannonVoyagerTaskReferenceDTO?,
        errorCode: String?
    ) {
        self.id = id
        self.title = title
        self.details = details
        self.operation = operation
        self.target = target
        self.projectIds = projectIds
        self.targetQuery = targetQuery
        self.updateFields = updateFields
        self.projectSelectionRequired = projectSelectionRequired
        self.decision = decision
        self.destinationStatus = destinationStatus
        self.requestId = requestId
        self.idempotencyKey = idempotencyKey
        self.result = result
        self.errorCode = errorCode
    }
}

public struct ShannonOrganizeSessionDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let scopeKey: String
    public let threadId: String
    public let state: ShannonOrganizeSessionStateDTO
    public let revision: Int
    public let sourceMessageIds: [String]
    public let commandThroughMessageId: String?
    public let items: [ShannonOrganizeItemDTO]
    public let createdAt: String
    public let updatedAt: String
    public let appliedAt: String?
}

public struct ShannonOrganizeSessionEnvelopeDTO: Codable, Equatable, Sendable {
    public let session: ShannonOrganizeSessionDTO
}

public struct ShannonOrganizeSessionListDTO: Codable, Equatable, Sendable {
    public let sessions: [ShannonOrganizeSessionDTO]
}

public struct ShannonOrganizeDecisionRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let expectedRevision: Int
    public let decision: ShannonOrganizeDecisionDTO
    public let title: String?
    public let details: String?
    public let operation: ShannonOrganizeOperationDTO?
    public let target: ShannonVoyagerTaskProjectionDTO?
    public let projectIds: [String]?

    public init(
        scopeKey: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?,
        operation: ShannonOrganizeOperationDTO? = nil,
        target: ShannonVoyagerTaskProjectionDTO? = nil,
        projectIds: [String]? = nil
    ) {
        self.scopeKey = scopeKey
        self.expectedRevision = expectedRevision
        self.decision = decision
        self.title = title
        self.details = details
        self.operation = operation
        self.target = target
        self.projectIds = projectIds
    }
}

public struct ShannonOrganizeApplyRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let expectedRevision: Int
}

public struct ShannonOrganizeApplyResponseDTO: Codable, Equatable, Sendable {
    public let session: ShannonOrganizeSessionDTO
    public let appliedCount: Int
    public let tasks: [ShannonVoyagerTaskReferenceDTO]
}
