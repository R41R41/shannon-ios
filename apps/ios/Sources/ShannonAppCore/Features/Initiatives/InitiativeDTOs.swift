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
    /// Whether the message is about what she saw of the room. Servers since 2026-10-05 always send it.
    public var roomLook: Bool? = nil

    /// The reasons of her own messages that may be about the room on a server without `roomLook`:
    /// `saw` (`reach-out:saw:`), and `follow_up`, whose source does not say whether the second call was
    /// worded with a look in front of her (`reach-out:follow_up:seen:`). Kept on the safe side.
    static let roomLookReasonsBeforeFlag: Set<String> = ["saw", "follow_up"]

    /// A notice outside the Talk must not quote a message about the room (as the iPhone's push does not).
    /// The server's answer counts when it sent one; an older server is judged by what it does send:
    /// a look id (`body-look:`) or a reason of hers that can come from a look.
    public var isAboutTheRoom: Bool {
        if let roomLook { return roomLook }
        if bodyLookId != nil { return true }
        return kind == "reach_out" && reason.map(Self.roomLookReasonsBeforeFlag.contains) == true
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
