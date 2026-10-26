import Foundation

public struct StoredConversationMessageDTO: Codable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let content: String
    public let observedAt: String
    public let messageEmotion: ShannonMessageEmotionDTO?
    public let stateVersion: Int?
    public let artifacts: [ShannonGeneratedArtifactDTO]?
    public let sourceAttribution: ShannonSourceAttributionDTO?
    /// The completed turn this message belongs to; captures are keyed by it.
    public let sourceExperienceId: String?
    public var feedback: ShannonFeedbackDTO? = nil
    /// Rich chat: a report card (owner alone, its work still visible) and the owner's reactions (owner alone).
    public var reportCard: ShannonReportCardDTO? = nil
    public var reactions: [String]? = nil
    /// Her own reactions on this message (rich chat §4), projected like `reactions`.
    public var shannonReactions: [String]? = nil
    public let captures: [ShannonTurnCaptureDTO]?
    public let reminder: ShannonReminderDTO?
    /// A piece of her study this message is about; the timeline shows a card that opens the reader.
    public let studyPiece: ShannonStudyPieceLinkDTO?

    public init(
        id: String,
        role: String,
        content: String,
        observedAt: String,
        messageEmotion: ShannonMessageEmotionDTO? = nil,
        stateVersion: Int? = nil,
        artifacts: [ShannonGeneratedArtifactDTO]? = nil,
        sourceAttribution: ShannonSourceAttributionDTO? = nil,
        sourceExperienceId: String? = nil,
        captures: [ShannonTurnCaptureDTO]? = nil,
        reminder: ShannonReminderDTO? = nil,
        studyPiece: ShannonStudyPieceLinkDTO? = nil
    ) {
        self.studyPiece = studyPiece
        self.sourceExperienceId = sourceExperienceId
        self.captures = captures
        self.reminder = reminder
        self.id = id
        self.role = role
        self.content = content
        self.observedAt = observedAt
        self.messageEmotion = messageEmotion
        self.stateVersion = stateVersion
        self.artifacts = artifacts
        self.sourceAttribution = sourceAttribution
    }
}

public struct ShannonSourceAttributionDTO: Codable, Equatable, Sendable {
    public let title: String
    public let url: String
    public let reason: String

    public init(title: String, url: String, reason: String) {
        self.title = title
        self.url = url
        self.reason = reason
    }
}

public struct ConversationHistoryResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let messages: [StoredConversationMessageDTO]
    public let state: CompanionStateDTO
}

public struct ThreadListResponseDTO: Codable, Equatable, Sendable {
    public let threads: [ChatThreadDTO]
}

public struct ThreadCreateRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let title: String?

    public init(scopeKey: String, title: String? = nil) {
        self.scopeKey = scopeKey
        self.title = title
    }
}

public struct ThreadCreateResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
}

public struct ThreadArchiveRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String
}

public struct ThreadArchiveResponseDTO: Codable, Equatable, Sendable {
    public let archived: Bool
}

public struct ThreadRenameRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String
    public let title: String

    public init(scopeKey: String, threadId: String, title: String) {
        self.scopeKey = scopeKey
        self.threadId = threadId
        self.title = title
    }
}

public struct ThreadRenameResponseDTO: Codable, Equatable, Sendable {
    public let renamed: Bool
}
