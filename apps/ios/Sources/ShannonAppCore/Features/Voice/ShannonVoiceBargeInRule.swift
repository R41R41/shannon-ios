import Foundation

/// Whether a finished transcript that is not her echo stops Shannon while she speaks.
///
/// Owner decision 2026-10-05, the same rule as her Windows body: while her voice is sounding,
/// or within `tailSeconds` after it stopped, an utterance shorter than `shortCharacters`
/// (a backchannel, a cough, a fragment of her own voice) does not cut her off and is not
/// answered, unless it is a stop word. Longer utterances keep the echo guard's rule: anything
/// not mostly her own words is a barge-in. A short answer after she finished goes through.
struct ShannonVoiceBargeInRule: Equatable, Sendable {
    static let shortCharacters = 8
    static let tailSeconds: TimeInterval = 0.3
    /// Normalized like `ShannonSpeechEchoGuard.normalized` (katakana folded to hiragana).
    static let stopWords = [
        "止めて", "とめて", "止まって", "とまって", "待って", "まって", "待った", "待て",
        "すとっぷ", "stop", "やめて", "やめ", "静かに", "しずかに", "黙って", "だまって", "黙れ", "だまれ",
    ]

    private(set) var isSounding = false
    private(set) var lastSoundingAt: TimeInterval?
    private var startedNearVoice: Bool?

    mutating func voiceSounding(at now: TimeInterval) {
        isSounding = true
        lastSoundingAt = now
    }

    mutating func voiceStopped(at now: TimeInterval) {
        guard isSounding else { return }
        isSounding = false
        lastSoundingAt = now
    }

    func isNearVoice(at now: TimeInterval) -> Bool {
        isSounding || lastSoundingAt.map { now <= $0 + Self.tailSeconds } == true
    }

    /// The first speech start since the last transcript says where that transcript began.
    mutating func speechStarted(at now: TimeInterval) {
        if startedNearVoice == nil { startedNearVoice = isNearVoice(at: now) }
    }

    /// Decides one finished transcript and forgets where it began.
    mutating func admits(_ transcript: String, now: TimeInterval) -> Bool {
        defer { startedNearVoice = nil }
        let heard = ShannonSpeechEchoGuard.normalized(transcript)
        guard heard.count < Self.shortCharacters,
              startedNearVoice == true || isNearVoice(at: now) else { return true }
        return Self.isStopWord(heard)
    }

    static func isStopWord(_ normalized: String) -> Bool {
        stopWords.contains { normalized.contains($0) }
    }

    mutating func reset() {
        self = ShannonVoiceBargeInRule()
    }
}
