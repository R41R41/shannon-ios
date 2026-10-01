import Foundation

public struct ShannonVoiceCallContextTurnDTO: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Equatable, Sendable {
        case participant, shannon
    }

    public let role: Role
    public let text: String

    public init(role: Role, text: String) {
        self.role = role
        self.text = text
    }
}

/// What a 「友人も一緒」 turn sends so the reply can follow the call so far.
public struct ShannonVoiceCallContextDTO: Codable, Equatable, Sendable {
    public let turns: [ShannonVoiceCallContextTurnDTO]
    public let addressedByName: Bool
    public let followsShannonTurn: Bool
    public let introductionStart: Bool

    public init(
        turns: [ShannonVoiceCallContextTurnDTO],
        addressedByName: Bool,
        followsShannonTurn: Bool,
        introductionStart: Bool
    ) {
        self.turns = turns
        self.addressedByName = addressedByName
        self.followsShannonTurn = followsShannonTurn
        self.introductionStart = introductionStart
    }
}

/// The only memory of a 「友人も一緒」 period. It lives in the running call, is never written to
/// disk, and is dropped when the call ends unless the owner asks for a summary.
struct ShannonVoiceGuestCallState: Equatable, Sendable {
    static let requestTurnLimit = 24
    static let retainedTurnLimit = 60
    static let turnCharacterLimit = 600
    /// A reaction this soon after Shannon finished is treated as a reply to her.
    static let followUpWindow: TimeInterval = 12
    static let companionAnswerWindow: TimeInterval = 30
    /// Sent as the first turn when the owner switches by the control, so Shannon greets the friend.
    static let introductionCue = "（ライ氏が「友人も一緒」に切り替えました。そばにいるお友達に、はじめましての挨拶をしてください。）"

    private(set) var turns: [ShannonVoiceCallContextTurnDTO] = []
    private(set) var hadGuestPeriod = false
    private(set) var needsIntroduction = false
    private var companionAnswerDeadline: TimeInterval?

    mutating func beginGuestPeriod() {
        hadGuestPeriod = true
        needsIntroduction = true
        companionAnswerDeadline = nil
    }

    /// Records one completed exchange. Speech Shannon stayed quiet for is still context.
    mutating func record(participant: String, shannon: String) {
        append(.participant, participant)
        append(.shannon, shannon)
        needsIntroduction = false
        if turns.count > Self.retainedTurnLimit {
            turns.removeFirst(turns.count - Self.retainedTurnLimit)
        }
    }

    func requestContext(addressedByName: Bool, followsShannonTurn: Bool) -> ShannonVoiceCallContextDTO {
        ShannonVoiceCallContextDTO(
            turns: Array(turns.suffix(Self.requestTurnLimit)),
            addressedByName: addressedByName,
            followsShannonTurn: followsShannonTurn,
            introductionStart: needsIntroduction
        )
    }

    /// Turns for the optional end-of-call summary: only when both sides actually spoke.
    var summaryTurns: [ShannonVoiceCallContextTurnDTO]? {
        guard hadGuestPeriod,
              turns.contains(where: { $0.role == .participant }),
              turns.contains(where: { $0.role == .shannon }) else { return nil }
        return turns
    }

    mutating func askedAboutCompanion(now: TimeInterval) {
        companionAnswerDeadline = now + Self.companionAnswerWindow
    }

    /// True once: the answer to 「お友達も一緒ですか？」 is the very next utterance or nothing.
    mutating func takeCompanionQuestion(now: TimeInterval) -> Bool {
        defer { companionAnswerDeadline = nil }
        guard let companionAnswerDeadline else { return false }
        return now <= companionAnswerDeadline
    }

    static func follows(shannonTurnEndedAt: TimeInterval?, isSpeaking: Bool, now: TimeInterval) -> Bool {
        if isSpeaking { return true }
        guard let shannonTurnEndedAt else { return false }
        return now - shannonTurnEndedAt <= followUpWindow
    }

    private mutating func append(_ role: ShannonVoiceCallContextTurnDTO.Role, _ text: String) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        turns.append(.init(role: role, text: String(value.prefix(Self.turnCharacterLimit))))
    }
}
