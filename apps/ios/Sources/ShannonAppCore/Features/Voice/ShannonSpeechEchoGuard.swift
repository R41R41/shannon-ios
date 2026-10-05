import Foundation

/// Recognises Shannon's own voice coming back through the microphone.
///
/// Voice processing cancels most speaker bleed, but not all of it, and the recogniser
/// then reports Shannon's words as the owner's utterance. Shannon knows exactly what she
/// just said, so a final transcript made up almost entirely of that text is echo.
/// The check is content-based on purpose: it never discards speech that merely overlaps
/// playback in time, and it needs no calibration of microphone levels.
///
/// What she said is remembered when it is actually played, in both the text shown and the
/// form that was synthesized (product names in katakana, emoji removed), and is forgotten
/// `memorySeconds` after her voice last sounded, so the start of a long talk is still known
/// at its end (owner decision 2026-10-05, the same rule as her Windows body).
struct ShannonSpeechEchoGuard {
    /// Transcripts shorter than this are never judged: "うん" or "はい" cannot be told apart.
    static let minimumCharacters = 5
    /// From here a transcript may differ slightly from what Shannon said (recognition noise).
    /// Below it, only an exact copy counts, so a short, genuine reply that reuses her words
    /// (「Voyagerの件ですか」 after 「Voyagerの件はどうする？」) is never discarded.
    static let fuzzyMinimumCharacters = 10
    /// Share of the transcript's character pairs that must appear in Shannon's recent speech.
    static let coverageThreshold = 0.8
    /// Counted from the last moment her voice was sounding, not from when a sentence arrived.
    static let memorySeconds: TimeInterval = 90
    /// A long talk of several minutes stays known as a whole.
    static let maximumRememberedCharacters = 6_000

    private struct Entry {
        /// The display text and the synthesized form, normalized.
        let shown: String
        let spoken: String
    }

    private var entries: [Entry] = []
    private(set) var lastSoundingAt: TimeInterval?

    /// One sentence of hers, at the moment its audio was played.
    mutating func recordPlayed(_ text: String, at now: TimeInterval) {
        let shown = Self.normalized(text)
        let spoken = Self.normalized(ShannonGeminiCascadeSpeech.spokenText(for: text))
        guard !shown.isEmpty || !spoken.isEmpty else { return }
        markSounding(at: now)
        entries.append(Entry(shown: shown, spoken: spoken))
        var total = entries.reduce(0) { $0 + max($1.shown.count, $1.spoken.count) }
        while total > Self.maximumRememberedCharacters, entries.count > 1 {
            let first = entries.removeFirst()
            total -= max(first.shown.count, first.spoken.count)
        }
    }

    /// Her voice was sounding at `now`; what she said is kept for another `memorySeconds`.
    mutating func markSounding(at now: TimeInterval) {
        if let lastSoundingAt, now - lastSoundingAt > Self.memorySeconds { entries.removeAll() }
        lastSoundingAt = max(lastSoundingAt ?? now, now)
    }

    mutating func reset() {
        entries.removeAll()
        lastSoundingAt = nil
    }

    func isEcho(_ transcript: String, now: TimeInterval) -> Bool {
        let heard = Self.normalized(transcript)
        guard heard.count >= Self.minimumCharacters,
              let lastSoundingAt, now - lastSoundingAt <= Self.memorySeconds else { return false }
        return Self.matches(heard, entries.map(\.shown).joined())
            || Self.matches(heard, entries.map(\.spoken).joined())
    }

    private static func matches(_ heard: String, _ spoken: String) -> Bool {
        guard !spoken.isEmpty else { return false }
        if spoken.contains(heard) { return true }
        guard heard.count >= fuzzyMinimumCharacters else { return false }
        let known = pairs(of: spoken)
        let heardPairs = pairList(of: heard)
        guard !heardPairs.isEmpty else { return false }
        let covered = heardPairs.filter { known.contains($0) }.count
        return Double(covered) / Double(heardPairs.count) >= coverageThreshold
    }

    /// Folds width, case and kana script, and drops punctuation, symbols, emoji and spaces,
    /// so a transcript compares with Shannon's display text regardless of notation.
    static func normalized(_ text: String) -> String {
        let folded = text.precomposedStringWithCompatibilityMapping.lowercased()
        let hiragana = folded.applyingTransform(.hiraganaToKatakana, reverse: true) ?? folded
        let keep = CharacterSet.letters.union(.decimalDigits)
        return String(String.UnicodeScalarView(hiragana.unicodeScalars.filter { keep.contains($0) }))
    }

    private static func pairList(of text: String) -> [String] {
        let characters = Array(text)
        guard characters.count >= 2 else { return [] }
        return (0..<(characters.count - 1)).map { String([characters[$0], characters[$0 + 1]]) }
    }

    private static func pairs(of text: String) -> Set<String> {
        Set(pairList(of: text))
    }
}

/// Decides when a transcript has to be compared with Shannon's own speech.
///
/// Recognition lags, so her last words can arrive just after playback ends; that grace period
/// stays. A short transcript whose speech *began* after she had finished is a person answering
/// her — 「はじめまして」 back to 「はじめまして、シャノンです」 — and is not compared at all.
/// Longer transcripts keep the full check, because an echo delayed by a slow network is long.
struct ShannonVoiceEchoWindow: Equatable, Sendable {
    enum Origin: Equatable, Sendable { case unknown, duringPlayback, afterPlayback }

    static let graceSeconds: TimeInterval = 5
    /// Speaker output and room echo trail the last scheduled sample slightly.
    static let playbackTailSeconds: TimeInterval = 0.25

    private(set) var playbackEndedAt: TimeInterval?
    private(set) var origin: Origin = .unknown

    mutating func playbackEnded(at now: TimeInterval) {
        playbackEndedAt = now
    }

    /// The first speech start since the last transcript decides where that transcript came from.
    mutating func speechStarted(isSpeaking: Bool, now: TimeInterval) {
        guard origin == .unknown else { return }
        let inTail = playbackEndedAt.map { now < $0 + Self.playbackTailSeconds } ?? false
        origin = isSpeaking || inTail ? .duringPlayback : .afterPlayback
    }

    mutating func shouldCompare(_ transcript: String, isSpeaking: Bool, now: TimeInterval) -> Bool {
        defer { origin = .unknown }
        if isSpeaking { return true }
        guard let playbackEndedAt, now < playbackEndedAt + Self.graceSeconds else { return false }
        let short = ShannonSpeechEchoGuard.normalized(transcript).count < ShannonSpeechEchoGuard.fuzzyMinimumCharacters
        return !(origin == .afterPlayback && short)
    }

    mutating func reset() {
        playbackEndedAt = nil
        origin = .unknown
    }
}
