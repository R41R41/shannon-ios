import Foundation

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
    public var commitment: ShannonCommitmentDTO? = nil
}

public struct ShannonCommitmentDTO: Codable, Equatable, Sendable {
    public let status: String
    public let dueAt: String?
    public let dueDate: String?
    public let dueHint: String?
    public let timeZone: String?

    public var statusLabel: String {
        switch status {
        case "completed": "完了"
        case "dismissed": "取り消し済み"
        default: "未完了の約束"
        }
    }
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
    public var commitmentReview: ShannonCommitmentSleepReviewDTO? = nil
    public let dayKey: String
    public let completedAt: String
    public let learned: [ShannonSleepChangeDTO]
    public let updated: [ShannonSleepChangeDTO]
    public let interestChanges: [ShannonSleepChangeDTO]
    public let contradictions: [ShannonSleepContradictionDTO]

    public var id: String { "\(dayKey):\(completedAt)" }
}

public struct ShannonCommitmentSleepReviewDTO: Codable, Equatable, Sendable {
    public let pending: Int
    public let completed: Int
    public let dismissed: Int
    public let needsDateClarification: Int
    public let overdue: Int
}

public struct ShannonMemoryDashboardDTO: Codable, Equatable, Sendable {
    public let generatedAt: String
    public let currentState: CompanionStateDTO?
    public let knowledge: [ShannonKnowledgeAnswerDTO]?
    public let personalityProfile: ShannonPersonalityProfileDTO?
    public let activity: [ShannonActivityItemDTO]?
    public let world: [ShannonWorldItemDTO]?
    public let usage: ShannonLlmUsageSummaryDTO?
    public let evaluation: ShannonInitiativeEvaluationDTO?
    public let dailyMind: ShannonDailyMindDTO?
    public let items: [ShannonMemoryItemDTO]
    public let sleepReports: [ShannonSleepReportDTO]

    public init(
        generatedAt: String,
        currentState: CompanionStateDTO? = nil,
        knowledge: [ShannonKnowledgeAnswerDTO]? = nil,
        personalityProfile: ShannonPersonalityProfileDTO? = nil,
        activity: [ShannonActivityItemDTO]? = nil,
        world: [ShannonWorldItemDTO]? = nil,
        usage: ShannonLlmUsageSummaryDTO? = nil,
        evaluation: ShannonInitiativeEvaluationDTO? = nil,
        dailyMind: ShannonDailyMindDTO? = nil,
        items: [ShannonMemoryItemDTO],
        sleepReports: [ShannonSleepReportDTO]
    ) {
        self.generatedAt = generatedAt
        self.currentState = currentState
        self.knowledge = knowledge
        self.personalityProfile = personalityProfile
        self.activity = activity
        self.world = world
        self.usage = usage
        self.evaluation = evaluation
        self.dailyMind = dailyMind
        self.items = items
        self.sleepReports = sleepReports
    }
}

public struct ShannonDailyMindDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let dayKey: String
    public let topic: String
    public let reason: String
    public let sourceItemId: String?
    public let sourceTitle: String?
    public let sourceURL: String?
    public let openingLine: String?
    public let createdAt: String
    public let expiresAt: String
}

public struct ShannonInitiativeEvaluationDTO: Codable, Equatable, Sendable {
    public let windowDays: Int
    public let runs: Int
    public let eligibleRuns: Int
    public let delivered: Int
    public let deliveryRate: Double
    public let candidatesConsidered: Int
    public let repeatedCandidatesSuppressed: Int?
    public let deliveredBySource: [ShannonInitiativeSourceCountDTO]?
    public let stopped: [String: Int]
}

public struct ShannonInitiativeSourceCountDTO: Codable, Equatable, Sendable {
    public let sourceTitle: String
    public let count: Int
}

public struct ShannonPersonalityProfileDTO: Codable, Equatable, Sendable {
    public let version: Int
    public let analysis: String
    public let createdAt: String
}

public struct ShannonKnowledgeEvidenceDTO: Codable, Equatable, Sendable {
    public let quote: String
    public let source: String
    public let observedAt: String
}

public struct ShannonKnowledgeAnswerDTO: Codable, Equatable, Identifiable, Sendable {
    public let answerId: String
    public let questionKey: String
    public let category: String
    public let question: String
    public let answer: String
    public let confidence: Double
    public let source: String
    public let confirmed: Bool
    public let updatedAt: String
    public let evidence: [ShannonKnowledgeEvidenceDTO]

    public var id: String { answerId }
}

public struct ShannonActivityItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let type: String
    public let title: String
    public let detail: String?
    public let occurredAt: String
}

public struct ShannonWorldItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let sourceId: String
    public let sourceTitle: String
    public let title: String
    public let url: String
    public let summary: String?
    public let author: String?
    public let publishedAt: String?
    public let discoveredAt: String
}

public struct ShannonLlmUsageRowDTO: Codable, Equatable, Identifiable, Sendable {
    public let lane: String
    public let calls: Int
    public let inputTokens: Int
    public let cachedInputTokens: Int
    public let outputTokens: Int
    public let totalTokens: Int
    public let estimatedCostUsd: Double

    public var id: String { lane }
}

public struct ShannonLlmUsageSummaryDTO: Codable, Equatable, Sendable {
    public let monthKey: String
    public let dayKey: String?
    public let estimatedCostUsd: Double
    public let backgroundCostUsd: Double
    public let todayBackgroundCostUsd: Double?
    public let backgroundBudgetUsd: Double
    public let backgroundRemainingUsd: Double
    public let rows: [ShannonLlmUsageRowDTO]
}

public enum ShannonMemoryActionDTO: String, Codable, Equatable, Sendable {
    case correct
    case forget
    case pin
    case unpin
    case reject
    case restore
    case complete
    case dismiss
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

public struct ShannonKnowledgeCorrectionDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let answerId: String
    public let answer: String
}
