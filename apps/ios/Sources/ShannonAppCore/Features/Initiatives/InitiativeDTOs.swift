import Foundation

public struct ShannonInitiativeMessageDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let threadId: String
    public let content: String
    public let expression: ShannonExpressionDTO
    public let sourceTitle: String
    public let sourceURL: String
    public let createdAt: String
    public let readAt: String?
}

public struct ShannonInitiativeInboxDTO: Codable, Equatable, Sendable {
    public let unreadCount: Int
    public let messages: [ShannonInitiativeMessageDTO]
}

public struct ShannonInitiativeReadRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String?
}

public struct ShannonInitiativeReadResponseDTO: Codable, Equatable, Sendable {
    public let markedRead: Int
}

public enum ShannonPushEnvironmentDTO: String, Codable, Equatable, Sendable {
    case sandbox
    case production
}

public struct ShannonPushRegistrationRequestDTO: Codable, Equatable, Sendable {
    public let deviceToken: String
    public let environment: ShannonPushEnvironmentDTO

    public init(deviceToken: String, environment: ShannonPushEnvironmentDTO) {
        self.deviceToken = deviceToken
        self.environment = environment
    }
}

public struct ShannonPushRegistrationResponseDTO: Codable, Equatable, Sendable {
    public let registered: Bool
}
