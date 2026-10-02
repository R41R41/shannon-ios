import Foundation
#if os(iOS)
@preconcurrency import AVFoundation
#endif

/// How her line for a touch is given back, following the mode of the surface the owner is on
/// (owner decision 2026-10-03: 「声で返事するモードでは声で、文字で返事するモードでは文字で」).
///
/// The app has no "read replies aloud" preference of its own, so the body screen carries the one
/// control (声で返す／文字で返す, default 文字). Talk and the dialogue stage answer in text and are text.
public enum ShannonBodyReplyMode: String, CaseIterable, Identifiable, Sendable {
    case text
    case voice

    public static let storageKey = "shannon.body.reply-mode"

    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .text: "文字で返す"
        case .voice: "声で返す"
        }
    }

    public static func current(defaults: UserDefaults = .standard) -> ShannonBodyReplyMode {
        defaults.string(forKey: storageKey).flatMap(ShannonBodyReplyMode.init(rawValue:)) ?? .text
    }
}

/// The one place that knows whether the app's sound is taken. Her spoken line for a touch, her own
/// messages through the earphones, a voice conversation, dictation and a call from her all use one
/// audio session: whoever wants to speak asks here first, and a line prepares and gives back the
/// session through the earphone standby's own bookkeeping when that exists.
@MainActor
public final class ShannonSpeechArbiter {
    public static let shared = ShannonSpeechArbiter()

    /// A voice conversation, dictation or a call from her (also while it rings) holds the session. Set by the earphone controller.
    public var sessionInUse: (@MainActor () -> Bool)?
    /// One of her own messages is being said through the earphones.
    public var reachOutIsSpeaking: (@MainActor () -> Bool)?
    /// The standby's way of preparing the session for one spoken line and giving it back.
    public var beginSpeech: (@MainActor () throws -> Void)?
    public var endSpeech: (@MainActor () -> Void)?
    /// Her line for a touch is being fetched or spoken, or his answer to it is being listened for.
    public internal(set) var touchLineIsActive = false

    public init() {}

    /// Whether a touch line may not be spoken now.
    public var isBusyForTouchLine: Bool {
        (sessionInUse?() ?? false) || (reachOutIsSpeaking?() ?? false) || touchLineIsActive
    }

    /// Whether anything of hers that is not a conversation is speaking: a reach-out waits for it.
    public var touchLineHoldsSound: Bool { touchLineIsActive }
}

/// Says her line for a touch in her voice, as her desktop body does, and then lets the owner answer.
///
/// The voice is the one of a voice conversation, played by the speaker that says her own messages
/// through the earphones (`ShannonEarphoneSpeaker`). While it plays, her figure is in the speaking
/// phase and her mouth follows the sound. Nothing is said while the sound is taken, and the line is
/// stopped the moment the owner leaves the screen, switches it off, or starts something else.
@MainActor
public final class ShannonBodyVoice {
    public typealias Listen = @MainActor (_ line: ShannonBodyTouchCoordinator.Line, _ seconds: Int) async -> Void

    /// A touch is answered at once or not aloud at all: later than this, the bubble is all there is.
    public static let firstSoundSeconds: TimeInterval = 6

    private let speaker: any ShannonReachOutSpeaking
    private let arbiter: ShannonSpeechArbiter
    private let callIsActive: @MainActor () -> Bool
    /// The surface still answers in voice: the body screen is up, 声で返す and 伝える are on, the app is in front.
    public var mayAnswerInVoice: @MainActor () -> Bool = { true }
    /// Opens the microphone for his answer; nil where there is no voice conversation to continue in (the Mac).
    public var listen: Listen?

    public init(
        streamSpeech: @escaping ShannonEarphoneSpeaker.StreamSpeech, callIsActive: @escaping @MainActor () -> Bool,
        arbiter: ShannonSpeechArbiter = .shared
    ) {
        let speaker = ShannonEarphoneSpeaker(streamSpeech: streamSpeech, monitor: ShannonSystemAudioRouteMonitor())
        speaker.firstSoundTimeout = Self.firstSoundSeconds
        self.speaker = speaker
        self.arbiter = arbiter
        self.callIsActive = callIsActive
        speaker.beginSession = { [arbiter] in try Self.beginSession(arbiter) }
        speaker.endSession = { [arbiter, callIsActive] in Self.endSession(arbiter, callIsActive: callIsActive) }
    }

    /// For tests: any speaker.
    init(speaker: any ShannonReachOutSpeaking, arbiter: ShannonSpeechArbiter, callIsActive: @escaping @MainActor () -> Bool = { false }) {
        self.speaker = speaker
        self.arbiter = arbiter
        self.callIsActive = callIsActive
    }

    /// Whether her line would be spoken if she said one now.
    public var canSpeakNow: Bool { !isTaken && mayAnswerInVoice() }

    private var isTaken: Bool { arbiter.isBusyForTouchLine || callIsActive() }
    /// The same, not counting this line itself.
    private var isTakenByOthers: Bool {
        (arbiter.sessionInUse?() ?? false) || (arbiter.reachOutIsSpeaking?() ?? false) || callIsActive()
    }

    /// Speaks the line, then listens for `listenSeconds`. A line said with other people around is never spoken
    /// and never listened for: the call that would hear his answer is an owner-alone conversation.
    public func say(_ line: ShannonBodyTouchCoordinator.Line) async {
        guard line.audience == .owner, canSpeakNow else { return }
        arbiter.touchLineIsActive = true
        defer { arbiter.touchLineIsActive = false }
        // Asked before the first sound, after the wait for the voice, and for every piece of sound.
        let outcome = await speaker.speak(line.text) { [weak self] in
            guard let self else { return false }
            return !self.isTakenByOthers && self.mayAnswerInVoice()
        }
        ShannonSpeechLevelPublisher.shared.end()
        // Only a line that was said to its end is answered aloud; everything is asked once more before the microphone opens.
        guard outcome == .spoken, line.listenSeconds > 0, let listen, !isTakenByOthers, mayAnswerInVoice() else { return }
        await listen(line, line.listenSeconds)
    }

    /// The owner left the screen, switched her voice or the reporting off, or the app left the foreground.
    public func stop() {
        speaker.stop()
    }

    private static func beginSession(_ arbiter: ShannonSpeechArbiter) throws {
        // With the earphone standby in the app, it prepares the session and knows that a line is being said.
        if let begin = arbiter.beginSpeech {
            try begin()
            return
        }
#if os(iOS)
        let session = AVAudioSession.sharedInstance()
        previous = (session.category, session.mode, session.categoryOptions)
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
#endif
    }

    private static func endSession(_ arbiter: ShannonSpeechArbiter, callIsActive: @MainActor () -> Bool) {
        if let end = arbiter.endSpeech {
            end()
            return
        }
#if os(iOS)
        // Something else took the session meanwhile: it is theirs now.
        guard !callIsActive(), !(arbiter.sessionInUse?() ?? false) else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        if let previous {
            try? session.setCategory(previous.category, mode: previous.mode, options: previous.options)
        }
        previous = nil
#endif
    }

#if os(iOS)
    /// What the session was before her line, without the standby: put back afterwards.
    private static var previous: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
#endif
}
