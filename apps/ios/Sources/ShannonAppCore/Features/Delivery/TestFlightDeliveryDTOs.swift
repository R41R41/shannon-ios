import Foundation

public enum ShannonTestFlightConditionDTO: String, Codable, Equatable, Sendable {
    case healthy
    case waiting
    case attention
}

public enum ShannonTestFlightDeliveryStatusDTO: String, Codable, Equatable, Sendable {
    case distributed
    case alreadyCurrent = "already-current"
    case noValidBuild = "no-valid-build"
    case failed
}

public enum ShannonTestFlightNotificationStatusDTO: String, Codable, Equatable, Sendable {
    case notNeeded = "not-needed"
    case pending
    case sent
    case suppressed
}

public enum ShannonReleaseGateKeyDTO: String, Codable, CaseIterable, Equatable, Identifiable, Sendable {
    case build, archive, upload, processing, assignment, install, smoke
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .build: "Build"
        case .archive: "Archive"
        case .upload: "Upload"
        case .processing: "Processing"
        case .assignment: "Assignment"
        case .install: "Install"
        case .smoke: "Smoke"
        }
    }
}

public enum ShannonReleaseGateStatusDTO: String, Codable, Equatable, Sendable {
    case pending, complete, attention
}

public struct ShannonReleaseGateDTO: Codable, Equatable, Identifiable, Sendable {
    public let key: ShannonReleaseGateKeyDTO
    public let status: ShannonReleaseGateStatusDTO
    public let completedAt: String?
    public var id: ShannonReleaseGateKeyDTO { key }
}

public struct ShannonReleaseProgressDTO: Codable, Equatable, Sendable {
    public let platform: String
    public let buildVersion: String?
    public let gates: [ShannonReleaseGateDTO]
}

public struct ShannonTestFlightDeliveryHistoryItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let status: ShannonTestFlightDeliveryStatusDTO
    public let buildVersion: String?
    public let checkedAt: String
    public let failureCode: String?
    public let notificationStatus: ShannonTestFlightNotificationStatusDTO

    public init(
        id: String,
        status: ShannonTestFlightDeliveryStatusDTO,
        buildVersion: String?,
        checkedAt: String,
        failureCode: String?,
        notificationStatus: ShannonTestFlightNotificationStatusDTO
    ) {
        self.id = id
        self.status = status
        self.buildVersion = buildVersion
        self.checkedAt = checkedAt
        self.failureCode = failureCode
        self.notificationStatus = notificationStatus
    }
}

public struct ShannonTestFlightDeliveryDashboardDTO: Codable, Equatable, Sendable {
    public let condition: ShannonTestFlightConditionDTO
    public let latestBuildVersion: String?
    public let lastCheckedAt: String?
    public let activeFailureCode: String?
    public let history: [ShannonTestFlightDeliveryHistoryItemDTO]
    public let release: ShannonReleaseProgressDTO?

    public init(
        condition: ShannonTestFlightConditionDTO,
        latestBuildVersion: String?,
        lastCheckedAt: String?,
        activeFailureCode: String?,
        history: [ShannonTestFlightDeliveryHistoryItemDTO],
        release: ShannonReleaseProgressDTO? = nil
    ) {
        self.condition = condition
        self.latestBuildVersion = latestBuildVersion
        self.lastCheckedAt = lastCheckedAt
        self.activeFailureCode = activeFailureCode
        self.history = history
        self.release = release
    }
}

public struct ShannonReleaseGateConfirmationDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let buildVersion: String
    public let gate: ShannonReleaseGateKeyDTO
}
