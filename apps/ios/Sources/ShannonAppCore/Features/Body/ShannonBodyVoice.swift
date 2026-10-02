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

/// Carries the id of a touch reaction to the first voice turn that answers it (`docs/body-contract.md`,
/// "If he answers"): the first delegation of the call names it, and so does the stored turn, so the Talk
/// reads her line → his words → her reply. One reaction at a time; a turn other people can hear never carries it.
public final class ShannonBodyReactionLink: @unchecked Sendable {
    public static let shared = ShannonBodyReactionLink()
    /// The server takes the first voice turn up to `listenSeconds` plus this after her line.
    static let marginSeconds: TimeInterval = 60

    private let lock = NSLock()
    private var reactionID: String?
    private var until = Date.distantPast
    private var delegated = false

    public init() {}

    public func arm(reactionID: String, listenSeconds: Int, now: Date = Date()) {
        lock.lock()
        self.reactionID = reactionID
        until = now.addingTimeInterval(TimeInterval(max(0, listenSeconds)) + Self.marginSeconds)
        delegated = false
        lock.unlock()
    }

    public func disarm() {
        lock.lock()
        reactionID = nil
        delegated = false
        lock.unlock()
    }

    /// For the first delegation of an owner call inside the window; nil for every other.
    public func forDelegation(ownerMode: Bool, now: Date = Date()) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard ownerMode, !delegated, let reactionID, now <= until else { return nil }
        delegated = true
        return reactionID
    }

    /// For the stored turn of that delegation, once. With someone else listening the turn is stored without it.
    public func forTurn(companionPresent: Bool) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard delegated, let reactionID else { return nil }
        self.reactionID = nil
        delegated = false
        return companionPresent ? nil : reactionID
    }
}

extension ShannonLiveVoiceDelegationRequestDTO {
    /// The same request, naming the touch reaction it answers when it is the first turn after one.
    func linkedToReaction(_ link: ShannonBodyReactionLink = .shared) -> Self {
        var linked = self
        linked.reactionId = link.forDelegation(ownerMode: participantMode == .owner)
        return linked
    }
}

extension ShannonRealtimeVoiceTurnRequestDTO {
    func linkedToReaction(_ link: ShannonBodyReactionLink = .shared) -> Self {
        var linked = self
        linked.reactionId = link.forTurn(companionPresent: companionPresent == true)
        return linked
    }
}

/// Says her line for a touch in her voice, as her desktop body does, and then lets the owner answer.
///
/// The voice is the one of a voice conversation, played by the speaker that says her own messages
/// through the earphones (`ShannonEarphoneSpeaker`), in the same audio session category. While it
/// plays, her figure is in the speaking phase and her mouth follows the sound. Nothing is said while
/// a voice conversation is running.
@MainActor
public final class ShannonBodyVoice {
    public typealias Listen = @MainActor (_ line: ShannonBodyTouchCoordinator.Line, _ seconds: Int) async -> Void

    private let speaker: ShannonEarphoneSpeaker
    private let callIsActive: @MainActor () -> Bool
    /// Opens the microphone for his answer; nil where there is no voice conversation to continue in (the Mac).
    public var listen: Listen?

    public init(streamSpeech: @escaping ShannonEarphoneSpeaker.StreamSpeech, callIsActive: @escaping @MainActor () -> Bool) {
        speaker = ShannonEarphoneSpeaker(streamSpeech: streamSpeech, monitor: ShannonSystemAudioRouteMonitor())
        self.callIsActive = callIsActive
#if os(iOS)
        // The category her earphone messages use: spoken audio that lowers other sound for its length.
        speaker.beginSession = {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        }
        speaker.endSession = { [callIsActive] in
            guard !callIsActive() else { return }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
#endif
    }

    /// Speaks the line, then listens for `listenSeconds`. The window opens whether or not the sound could be played.
    public func say(_ line: ShannonBodyTouchCoordinator.Line) async {
        guard !callIsActive() else { return }
        _ = await speaker.speak(line.text, stillPrivate: { true })
        ShannonSpeechLevelPublisher.shared.end()
        guard line.listenSeconds > 0, let listen, !callIsActive() else { return }
        await listen(line, line.listenSeconds)
    }

    public func stop() {
        speaker.stop()
    }
}
