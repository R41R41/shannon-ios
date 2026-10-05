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
    /// Set when the message is her words about one look at the room.
    public var bodyLookId: String? = nil
    /// `reach_out` when she started the message from her own activity, with its `reason`.
    public var kind: String? = nil
    public var reason: String? = nil
    /// True when the message is about what she saw of the room (servers since 2026-10-05).
    public var roomLook: Bool? = nil

    /// A notice outside the Talk must not quote a message about the room (as the iPhone's push does not).
    /// An older server without `roomLook` is judged by the look id and the reason.
    public var isAboutTheRoom: Bool {
        roomLook == true || bodyLookId != nil || (kind == "reach_out" && reason == "saw")
    }
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
