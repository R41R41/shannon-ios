import Foundation

/// When a voice conversation that went on in the background ends by itself (owner decision 2026-10-02).
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
    public static let limit: TimeInterval = 5 * 60
    /// How often a running call looks at the clock while in the background.
    public static let checkInterval: TimeInterval = 15

    public private(set) var enteredBackgroundAt: Date?
    public private(set) var lastSpeechAt: Date?

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
}

/// Fixed status text for a call that ended by itself. Neutral, not Shannon's voice.
public enum ShannonVoiceBackgroundCopy {
    public static let endedAfterSilence = "5分間お話がなかったので、音声会話を終了しました。会話は保存されています。"
}
