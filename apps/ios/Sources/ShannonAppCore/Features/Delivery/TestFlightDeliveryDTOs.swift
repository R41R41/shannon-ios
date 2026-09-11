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

    public init(
        condition: ShannonTestFlightConditionDTO,
        latestBuildVersion: String?,
        lastCheckedAt: String?,
        activeFailureCode: String?,
        history: [ShannonTestFlightDeliveryHistoryItemDTO]
    ) {
        self.condition = condition
        self.latestBuildVersion = latestBuildVersion
        self.lastCheckedAt = lastCheckedAt
        self.activeFailureCode = activeFailureCode
        self.history = history
    }
}
