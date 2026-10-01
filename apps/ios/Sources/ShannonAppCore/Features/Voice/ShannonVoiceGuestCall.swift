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
    /// Identifies this 「友人も一緒」 period so the server can remember who was met in it.
    public let callId: String?

    public init(
        turns: [ShannonVoiceCallContextTurnDTO],
        addressedByName: Bool,
        followsShannonTurn: Bool,
        introductionStart: Bool,
        callId: String? = nil
    ) {
        self.turns = turns
        self.addressedByName = addressedByName
        self.followsShannonTurn = followsShannonTurn
        self.introductionStart = introductionStart
        self.callId = callId
    }
}

/// One finished 「友人も一緒」 period: what the device hands to the server to be remembered.
struct ShannonVoiceGuestPeriod: Equatable, Sendable {
    let callID: String
    let turns: [ShannonVoiceCallContextTurnDTO]

    /// Nothing was said by anyone: there is nothing to remember, only server state to clear.
    var isEmpty: Bool { !turns.contains { $0.role == .participant } }
}

/// A 「友人も一緒」 period while it is running. It lives in the call and is never written to disk
/// on the device; when the period ends its turns are handed to the server once, to be remembered.
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
    /// Set while a period is running. A new period gets a new identifier.
    private(set) var callID: String?
    /// The owner said someone may be with him and the call stayed 本人だけ.
    private(set) var companionSuspected = false
    private var companionAnswerDeadline: TimeInterval?

    mutating func beginGuestPeriod(callID: String = UUID().uuidString.lowercased()) {
        hadGuestPeriod = true
        needsIntroduction = true
        companionAnswerDeadline = nil
        companionSuspected = false
        self.callID = callID
        turns = []
    }

    /// Closes the running period and returns what was said in it. Nil when no period is running.
    mutating func endGuestPeriod() -> ShannonVoiceGuestPeriod? {
        guard let callID else { return nil }
        defer {
            self.callID = nil
            turns = []
            needsIntroduction = false
        }
        return ShannonVoiceGuestPeriod(callID: callID, turns: turns)
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
            introductionStart: needsIntroduction,
            callId: callID
        )
    }

    mutating func askedAboutCompanion(now: TimeInterval) {
        companionAnswerDeadline = now + Self.companionAnswerWindow
        // Until the owner says otherwise, someone may be listening.
        companionSuspected = true
    }

    /// The owner answered that nobody else is there.
    mutating func companionDenied() { companionSuspected = false }

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
