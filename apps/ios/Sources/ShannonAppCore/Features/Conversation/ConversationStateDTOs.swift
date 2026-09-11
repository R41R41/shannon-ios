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
    public let threadId: String?
    public let attachments: [ShannonChatAttachmentDTO]?
    public let webSearch: Bool?

    public init(
        scopeKey: String,
        message: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO] = [],
        webSearch: Bool = false
    ) {
        self.scopeKey = scopeKey
        self.message = message
        self.threadId = threadId
        self.attachments = attachments.isEmpty ? nil : attachments
        self.webSearch = webSearch ? true : nil
    }
}

public struct ShannonChatAttachmentDTO: Codable, Equatable, Sendable {
    public let name: String
    public let mimeType: String
    public let text: String

    public init(name: String, mimeType: String, text: String) {
        self.name = name
        self.mimeType = mimeType
        self.text = text
    }
}

public struct ShannonGeneratedArtifactDTO: Codable, Equatable, Sendable {
    public let name: String
    public let mimeType: String
    public let content: String
    public let summary: String?

    public init(name: String, mimeType: String, content: String, summary: String? = nil) {
        self.name = name
        self.mimeType = mimeType
        self.content = content
        self.summary = summary
    }
}

public struct ChatThreadDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let messageCount: Int
    public let summary: String?
    public let sections: [String]?

    public init(
        threadId: String,
        title: String,
        createdAt: String,
        updatedAt: String,
        messageCount: Int,
        summary: String? = nil,
        sections: [String]? = nil
    ) {
        self.threadId = threadId
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messageCount = messageCount
        self.summary = summary
        self.sections = sections
    }
}

public struct ShannonUIBlockDTO: Codable, Equatable, Sendable {
    public let type: String
    public let proposalId: String?
    public let title: String?
    public let goal: String?
    public let hostHint: String?
    public let projectHint: String?
    public let risk: String?
    public let session: ShannonOrganizeSessionDTO?

    public init(
        type: String = "agent_task_proposal",
        proposalId: String? = nil,
        title: String? = nil,
        goal: String? = nil,
        hostHint: String? = nil,
        projectHint: String? = nil,
        risk: String? = nil,
        session: ShannonOrganizeSessionDTO? = nil
    ) {
        self.type = type
        self.proposalId = proposalId
        self.title = title
        self.goal = goal
        self.hostHint = hostHint
        self.projectHint = projectHint
        self.risk = risk
        self.session = session
    }
}
