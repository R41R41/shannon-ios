import Foundation

public struct ShannonTemperamentDTO: Codable, Equatable, Sendable {
    public let curiosity: Double
    public let initiative: Double
    public let closeness: Double
    public let calmness: Double
    public let needForContinuity: Double
    public let confidenceAboutUser: Double
}

public struct ShannonEmotionDTO: Codable, Equatable, Sendable {
    public let valence: Double
    public let arousal: Double
    public let openness: Double
}

public enum ShannonExpressionDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case joyful
    case curious
    case tender
    case calm
    case concerned
    case sad
    case sleepy
    case neutral
}

public struct ShannonMessageEmotionDTO: Codable, Equatable, Sendable {
    public let valence: Double
    public let arousal: Double
    public let openness: Double
    public let expression: ShannonExpressionDTO
}

public struct UserFactDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let statement: String
    public let confidence: Double
    public let observedAt: String
    public let evidence: String?
}

public struct ActiveMemoryDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let summary: String
    public let relevance: Double
    public let observedAt: String
}

public struct CompanionStateDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let version: Int
    public let updatedAt: String
    public let temperament: ShannonTemperamentDTO
    public let emotion: ShannonEmotionDTO
    public let interests: [String]
    public let userFacts: [UserFactDTO]
    public let activeMemories: [ActiveMemoryDTO]
}

public struct ChatRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let message: String

    public init(scopeKey: String, message: String) {
        self.scopeKey = scopeKey
        self.message = message
    }
}

public struct ChatResponseDTO: Codable, Equatable, Sendable {
    public let mode: String
    public let reply: String
    public let snapshotVersion: Int
    public let messageEmotion: ShannonMessageEmotionDTO
    public let systemPrompt: String
    public let state: CompanionStateDTO
}

public struct ConversationMessage: Equatable, Identifiable, Sendable {
    public enum Role: Equatable, Sendable {
        case user
        case shannon
    }

    public enum DeliveryState: Equatable, Sendable {
        case sending
        case sent
        case failed
    }

    public struct EmotionSnapshot: Equatable, Sendable {
        public let valence: Double
        public let arousal: Double
        public let openness: Double
        public let expression: ShannonExpressionDTO
        public let stateVersion: Int

        public init(
            valence: Double,
            arousal: Double,
            openness: Double,
            expression: ShannonExpressionDTO,
            stateVersion: Int
        ) {
            self.valence = valence
            self.arousal = arousal
            self.openness = openness
            self.expression = expression
            self.stateVersion = stateVersion
        }
    }

    public let id: UUID
    public let role: Role
    public let text: String
    public let sentAt: Date
    public let deliveryState: DeliveryState
    public let emotionSnapshot: EmotionSnapshot?

    public init(
        id: UUID = UUID(),
        role: Role,
        text: String,
        sentAt: Date = Date(),
        deliveryState: DeliveryState = .sent,
        emotionSnapshot: EmotionSnapshot? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.sentAt = sentAt
        self.deliveryState = deliveryState
        self.emotionSnapshot = emotionSnapshot
    }

    public func withDeliveryState(_ deliveryState: DeliveryState) -> ConversationMessage {
        ConversationMessage(
            id: id,
            role: role,
            text: text,
            sentAt: sentAt,
            deliveryState: deliveryState,
            emotionSnapshot: emotionSnapshot
        )
    }
}
