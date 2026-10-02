import Foundation

/// The few seconds the microphone stays open after Shannon said something on her own (owner decision
/// 2026-10-02: the rule of her desktop body). If the owner answers, it becomes a conversation; if he
/// does not, the microphone closes and nothing is stored.
///
/// The window is open for `seconds`. A sound heard just before it would close keeps it open a little
/// longer, so a sentence he has begun is not cut off, up to a fixed limit.
public struct ShannonAnswerWindow: Equatable, Sendable {
    /// A sound this recent keeps the window open past its end.
    public static let graceAfterSound: TimeInterval = 1.5
    /// However long he goes on making sound, the window is extended at most this much.
    public static let maximumExtension: TimeInterval = 8

    public let opensAt: Date
    public let seconds: TimeInterval
    public private(set) var lastSoundAt: Date?

    public init(opensAt: Date, seconds: TimeInterval) {
        self.opensAt = opensAt
        self.seconds = max(0, seconds)
    }

    public mutating func heardSound(at now: Date) {
        lastSoundAt = now
    }

    public func isOpen(at now: Date) -> Bool {
        let end = opensAt.addingTimeInterval(seconds)
        if now < end { return true }
        guard let lastSoundAt, now.timeIntervalSince(lastSoundAt) < Self.graceAfterSound else { return false }
        return now < end.addingTimeInterval(Self.maximumExtension)
    }
}

/// Where the call that listens for the answer stands.
public enum ShannonAnswerCallState: Equatable, Sendable {
    /// Asking for the microphone or connecting: the window has not opened yet.
    case starting
    case live
    /// It ended or failed.
    case ended
}

/// One look at the call that listens for the answer.
public struct ShannonAnswerObservation: Equatable, Sendable {
    public var call: ShannonAnswerCallState
    /// The owner said or typed something in this call.
    public var hasOwnerInput: Bool
    /// The microphone hears sound right now.
    public var hearsSound: Bool
    /// The call's sound still comes out only where the owner can hear it.
    public var isPrivate: Bool

    public init(call: ShannonAnswerCallState, hasOwnerInput: Bool, hearsSound: Bool, isPrivate: Bool) {
        self.call = call
        self.hasOwnerInput = hasOwnerInput
        self.hearsSound = hearsSound
        self.isPrivate = isPrivate
    }
}

/// How the few seconds after her own line ended.
public enum ShannonAnswerOutcome: Equatable, Sendable {
    /// The owner said something: the call is an ordinary voice conversation from here.
    case answered
    /// Nothing was said while the microphone was open.
    case silent
    /// The call did not get as far as listening, ended by itself, or its sound stopped being only the owner's.
    case unavailable
}

/// Watches the call that listens for the owner's answer for the length of the window.
public enum ShannonAnswerWait {
    /// The call may take this long to connect before the window is given up.
    public static let connectTimeout: TimeInterval = 12
    public static let pollInterval: TimeInterval = 0.1

    /// `sleep` returns false when the wait was cancelled.
    @MainActor
    public static func run(
        seconds: Int,
        observe: @MainActor () -> ShannonAnswerObservation,
        now: () -> Date = { Date() },
        sleep: (TimeInterval) async -> Bool
    ) async -> ShannonAnswerOutcome {
        let connectDeadline = now().addingTimeInterval(connectTimeout)
        var observation = observe()
        while observation.call == .starting {
            guard now() < connectDeadline, await sleep(pollInterval) else { return .unavailable }
            observation = observe()
        }
        var window = ShannonAnswerWindow(opensAt: now(), seconds: TimeInterval(seconds))
        while true {
            // Asked before anything else: a call whose sound is no longer only his is given up, answered or not.
            guard observation.call == .live, observation.isPrivate else { return .unavailable }
            if observation.hasOwnerInput { return .answered }
            let moment = now()
            if observation.hearsSound { window.heardSound(at: moment) }
            guard window.isOpen(at: moment) else { return .silent }
            guard await sleep(pollInterval) else { return .unavailable }
            observation = observe()
        }
    }
}

/// Decides, from the level of a microphone, whether the owner answered and when he finished. Used where
/// there is no speech recogniser running (the Mac): what is recorded is sent to be transcribed only if
/// this says he spoke.
public struct ShannonAnswerDetector: Equatable, Sendable {
    public enum Decision: Equatable, Sendable {
        /// Keep the microphone open.
        case waiting
        /// He did not answer: close the microphone and keep nothing.
        case silent
        /// He spoke and has stopped: what was recorded is his answer.
        case answered
    }

    /// Sound has to last this long to count as speech rather than a click or a cough.
    public static let onset: TimeInterval = 0.25
    /// This much quiet after speech ends the answer.
    public static let trailingSilence: TimeInterval = 1.2
    /// An answer is cut at this length.
    public static let maximumAnswer: TimeInterval = 30
    /// Bounds of the level, in dBFS, above which sound counts; the room's own noise places it between them.
    public static let quietestThreshold: Float = -45
    public static let loudestThreshold: Float = -25
    static let marginOverNoise: Float = 12
    static let noiseSampling: TimeInterval = 0.3

    public private(set) var window: ShannonAnswerWindow
    public private(set) var speechStartedAt: Date?
    private var loudSince: Date?
    private var lastLoudAt: Date?
    private var noiseFloor: Float?

    public init(opensAt: Date, seconds: TimeInterval) {
        window = ShannonAnswerWindow(opensAt: opensAt, seconds: seconds)
    }

    public var threshold: Float {
        guard let noiseFloor else { return Self.quietestThreshold + Self.marginOverNoise }
        return min(Self.loudestThreshold, max(Self.quietestThreshold, noiseFloor + Self.marginOverNoise))
    }

    /// One reading of the microphone level in dBFS.
    public mutating func observe(level: Float, at now: Date) -> Decision {
        // The first moments measure the room; the quietest reading is its noise.
        if now.timeIntervalSince(window.opensAt) <= Self.noiseSampling {
            noiseFloor = min(noiseFloor ?? level, level)
        }
        let loud = level > threshold
        if loud {
            if loudSince == nil { loudSince = now }
            lastLoudAt = now
            window.heardSound(at: now)
        } else {
            loudSince = nil
        }
        if let speechStartedAt {
            if now.timeIntervalSince(speechStartedAt) >= Self.maximumAnswer { return .answered }
            if let lastLoudAt, now.timeIntervalSince(lastLoudAt) >= Self.trailingSilence { return .answered }
            return .waiting
        }
        if let loudSince, now.timeIntervalSince(loudSince) >= Self.onset {
            speechStartedAt = loudSince
            return .waiting
        }
        return window.isOpen(at: now) ? .waiting : .silent
    }
}
