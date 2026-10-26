import Foundation

public struct ChatResponseDTO: Codable, Equatable, Sendable {
    public let thread: ChatThreadDTO?
    public let mode: String
    public let reply: String
    public let threadId: String
    public let snapshotVersion: Int
    public let messageEmotion: ShannonMessageEmotionDTO
    public let systemPrompt: String
    public let state: CompanionStateDTO
    public let uiBlocks: [ShannonUIBlockDTO]?
    public let artifacts: [ShannonGeneratedArtifactDTO]?
    /// Absent on servers that do not record per-turn captures.
    public let turnId: String?
    public var feedback: ShannonFeedbackDTO? = nil
    /// She looks through this app's camera now: capture one frame and answer it.
    public var appLook: ShannonAppLookAskDTO? = nil
    /// Her reaction on the message this turn answered (rich chat §4); absent from older servers and on most turns.
    public var shannonReaction: ShannonOwnReactionDTO? = nil

    public init(
        mode: String,
        reply: String,
        threadId: String,
        snapshotVersion: Int,
        messageEmotion: ShannonMessageEmotionDTO,
        systemPrompt: String,
        state: CompanionStateDTO,
        uiBlocks: [ShannonUIBlockDTO]? = nil,
        artifacts: [ShannonGeneratedArtifactDTO]? = nil,
        thread: ChatThreadDTO? = nil,
        turnId: String? = nil
    ) {
        self.turnId = turnId
        self.thread = thread
        self.mode = mode
        self.reply = reply
        self.threadId = threadId
        self.snapshotVersion = snapshotVersion
        self.messageEmotion = messageEmotion
        self.systemPrompt = systemPrompt
        self.state = state
        self.uiBlocks = uiBlocks
        self.artifacts = artifacts
    }
}
