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
    case excited
    case amused
    case laughing
    case bashful
    case embarrassed
    case relieved
    case surprised
    case curious
    case thinking
    case confused
    case determined
    case tender
    case calm
    case jealous
    case wry
    case exasperated
    case annoyed
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

public struct StoredConversationMessageDTO: Codable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let content: String
    public let observedAt: String
    public let messageEmotion: ShannonMessageEmotionDTO?
    public let stateVersion: Int?
}

public struct ConversationHistoryResponseDTO: Codable, Equatable, Sendable {
    public let messages: [StoredConversationMessageDTO]
    public let state: CompanionStateDTO
}

public enum ShannonMemoryKindDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case userFact = "user-fact"
    case interest
    case experience
    case relationship

    public var japaneseName: String {
        switch self {
        case .userFact: "あなたについて"
        case .interest: "シャノンの興味"
        case .experience: "思い出"
        case .relationship: "ふたりの関係"
        }
    }

    public var symbolName: String {
        switch self {
        case .userFact: "person.text.rectangle"
        case .interest: "sparkles"
        case .experience: "bubble.left.and.bubble.right"
        case .relationship: "heart.text.square"
        }
    }
}

public enum ShannonMemoryStatusDTO: String, Codable, Equatable, Sendable {
    case active
    case forgotten
    case rejected
}

public struct ShannonMemoryEvidenceDTO: Codable, Equatable, Sendable {
    public let quote: String
    public let observedAt: String
    public let source: String
}

public struct ShannonMemoryItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: ShannonMemoryKindDTO
    public let text: String
    public let confidence: Double?
    public let relevance: Double?
    public let status: ShannonMemoryStatusDTO
    public let pinned: Bool
    public let createdAt: String
    public let updatedAt: String
    public let changeReason: String
    public let evidence: [ShannonMemoryEvidenceDTO]
}

public struct ShannonSleepChangeDTO: Codable, Equatable, Identifiable, Sendable {
    public let kind: ShannonMemoryKindDTO
    public let memoryId: String
    public let text: String
    public let reason: String
    public let evidence: String?

    public var id: String { "\(kind.rawValue):\(memoryId):\(text)" }
}

public struct ShannonSleepContradictionDTO: Codable, Equatable, Identifiable, Sendable {
    public let kind: ShannonMemoryKindDTO
    public let memoryId: String
    public let currentText: String
    public let candidateText: String
    public let reason: String
    public let evidence: String

    public var id: String { "\(kind.rawValue):\(memoryId):\(candidateText)" }
}

public struct ShannonSleepReportDTO: Codable, Equatable, Identifiable, Sendable {
    public let dayKey: String
    public let completedAt: String
    public let learned: [ShannonSleepChangeDTO]
    public let updated: [ShannonSleepChangeDTO]
    public let interestChanges: [ShannonSleepChangeDTO]
    public let contradictions: [ShannonSleepContradictionDTO]

    public var id: String { "\(dayKey):\(completedAt)" }
}

public struct ShannonMemoryDashboardDTO: Codable, Equatable, Sendable {
    public let generatedAt: String
    public let items: [ShannonMemoryItemDTO]
    public let sleepReports: [ShannonSleepReportDTO]
}

public enum ShannonMemoryActionDTO: String, Codable, Equatable, Sendable {
    case correct
    case forget
    case pin
    case unpin
    case reject
    case restore
}

public struct ShannonMemoryMutationDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let memoryId: String
    public let action: ShannonMemoryActionDTO
    public let text: String?

    public init(scopeKey: String, memoryId: String, action: ShannonMemoryActionDTO, text: String? = nil) {
        self.scopeKey = scopeKey
        self.memoryId = memoryId
        self.action = action
        self.text = text
    }
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
