import Foundation

public enum ShannonCognitiveIntentStatusDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case active
    case paused
    case completed
    case dismissed

    public var japaneseName: String {
        switch self {
        case .active: "継続中"
        case .paused: "一時停止"
        case .completed: "完了"
        case .dismissed: "取り下げ済み"
        }
    }

    public var symbolName: String {
        switch self {
        case .active: "target"
        case .paused: "pause.circle"
        case .completed: "checkmark.circle"
        case .dismissed: "xmark.circle"
        }
    }
}

public struct ShannonCognitiveIntentDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let desiredOutcome: String
    public let status: ShannonCognitiveIntentStatusDTO
    public let source: String
    public let sourceExperienceId: String?
    public let threadId: String?
    public let nextStep: String?
    public let priority: Double
    public let confidence: Double
    public let createdAt: String
    public let updatedAt: String
}

public struct ShannonCognitiveCycleDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let threadId: String
    public let channel: String
    public let primaryIntentID: String?
    public let recalledMemoryIDs: [String]
    public let action: String
    public let outcome: String
    public let summary: String
    public let occurredAt: String

    public var actionLabel: String {
        switch action {
        case "command": "スキルを実行"
        case "delegate": "作業を依頼"
        default: "応答"
        }
    }

    public var channelLabel: String {
        switch channel {
        case "voice": "音声"
        case "discord": "Discord"
        case "vision": "カメラ"
        case "platform": "外部サービス"
        case "system": "システム"
        default: "テキスト"
        }
    }
}

public struct ShannonCognitionDashboardDTO: Codable, Equatable, Sendable {
    public let intents: [ShannonCognitiveIntentDTO]
    public let recentCycles: [ShannonCognitiveCycleDTO]

    public static let empty = ShannonCognitionDashboardDTO(intents: [], recentCycles: [])

    public init(intents: [ShannonCognitiveIntentDTO], recentCycles: [ShannonCognitiveCycleDTO]) {
        self.intents = intents
        self.recentCycles = recentCycles
    }
}

public struct ShannonCognitiveIntentStatusRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let intentId: String
    public let status: ShannonCognitiveIntentStatusDTO
}

public struct ShannonCognitiveIntentStatusResponseDTO: Codable, Equatable, Sendable {
    public let intent: ShannonCognitiveIntentDTO
}
