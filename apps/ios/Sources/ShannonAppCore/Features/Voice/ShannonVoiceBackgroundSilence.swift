import Foundation

/// When a voice conversation that went on in the background ends by itself (owner decisions 2026-10-02 and
/// 2026-10-03: one minute of silence, 「無言なら1分で終わりでいい」).
///
/// A call keeps running after the owner leaves the app. While the app is in the background it ends
/// once neither side has spoken for `limit`, exactly as if the owner had ended it. In the foreground
/// there is no such timer: the call screen is in front of him and he ends it himself.
///
/// "Spoken" means recognised speech: a transcript of the owner's words, or audio of Shannon's reply.
/// A raw microphone level does not count, so noise in a pocket cannot keep a call alive.
/// Wall-clock time is used on purpose: it keeps counting while the app is suspended by an interruption.
public struct ShannonVoiceBackgroundSilence: Equatable, Sendable {
    /// Silence from both sides, in the background, after which the call ends.
    public static let limit: TimeInterval = 60
    /// How often a running call looks at the clock while in the background.
    public static let checkInterval: TimeInterval = 5
    /// While a phone call, Siri or another app holds the audio, nobody can speak: the call waits this long for the
    /// audio to come back before it ends, instead of the minute.
    public static let interruptedLimit: TimeInterval = 5 * 60
    /// An utterance of the owner's that the recogniser has heard begin keeps the call open at most this long,
    public static let maximumOpenUtterance: TimeInterval = 120
    /// and, once it has heard it end, this long while its words are still being recognised. Noise the recogniser
    /// takes for speech never becomes words, so it holds a call no longer than these two bounds.
    public static let awaitingWords: TimeInterval = 30

    public private(set) var enteredBackgroundAt: Date?
    public private(set) var lastSpeechAt: Date?
    public private(set) var ownerSpeechStartedAt: Date?
    public private(set) var ownerSpeechStoppedAt: Date?

    public init() {}

    public var isInBackground: Bool { enteredBackgroundAt != nil }

    public mutating func enteredBackground(at now: Date) {
        if enteredBackgroundAt == nil { enteredBackgroundAt = now }
    }

    public mutating func enteredForeground() {
        enteredBackgroundAt = nil
    }

    public mutating func speech(at now: Date) {
        lastSpeechAt = now
    }

    /// The recogniser heard the owner begin to speak. His words arrive only when he has finished.
    public mutating func ownerSpeechStarted(at now: Date) {
        ownerSpeechStartedAt = now
        ownerSpeechStoppedAt = nil
    }

    public mutating func ownerSpeechStopped(at now: Date) {
        if ownerSpeechStartedAt != nil { ownerSpeechStoppedAt = now }
    }

    /// The owner's words arrived: that is speech, and his utterance is closed.
    public mutating func ownerSpoke(at now: Date) {
        lastSpeechAt = now
        ownerSpeechStartedAt = nil
        ownerSpeechStoppedAt = nil
    }

    /// He is speaking, or has just finished and his words are not recognised yet. It does not count as speech
    /// by itself (it may be noise); it only keeps the call from ending in the middle of a sentence.
    public func ownerUtteranceOpen(at now: Date) -> Bool {
        guard let started = ownerSpeechStartedAt else { return false }
        if let stopped = ownerSpeechStoppedAt { return now.timeIntervalSince(stopped) < Self.awaitingWords }
        return now.timeIntervalSince(started) < Self.maximumOpenUtterance
    }

    /// Silence is counted from the later of leaving the app and the last speech, so a quiet
    /// stretch in the foreground does not end the call the moment the owner switches apps.
    public func silence(at now: Date) -> TimeInterval? {
        guard let enteredBackgroundAt else { return nil }
        let since = max(enteredBackgroundAt, lastSpeechAt ?? enteredBackgroundAt)
        return max(0, now.timeIntervalSince(since))
    }

    public func shouldEnd(at now: Date) -> Bool {
        guard let silence = silence(at: now) else { return false }
        return silence >= Self.limit
    }

    /// The same question asked by a running call.
    /// - While a reply is being made or played (she is thinking, waiting for a tool or a look, or still speaking a
    ///   long answer) the call is not silent however long it takes: the count starts again from that moment, so
    ///   the minute runs from when she has finished.
    /// - While the owner is in the middle of an utterance the call does not end either.
    /// - While the audio is interrupted the longer limit applies.
    /// Words of his that were never answered (a reply that failed) do not count: the minute runs from the failure.
    public mutating func shouldEnd(at now: Date, replyInProgress: Bool, interrupted: Bool = false) -> Bool {
        guard isInBackground else { return false }
        if replyInProgress {
            lastSpeechAt = now
            return false
        }
        if ownerUtteranceOpen(at: now) { return false }
        guard let silence = silence(at: now) else { return false }
        return silence >= (interrupted ? Self.interruptedLimit : Self.limit)
    }
}

/// Fixed status text for a call that ended by itself. Neutral, not Shannon's voice.
public enum ShannonVoiceBackgroundCopy {
    public static let endedAfterSilence = "1分間お話がなかったので、音声会話を終了しました。会話は保存されています。"
}
