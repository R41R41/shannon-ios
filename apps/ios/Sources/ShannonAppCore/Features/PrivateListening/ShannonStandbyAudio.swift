import Foundation
#if os(iOS)
@preconcurrency import AVFoundation
#endif

/// What the iPhone's standby is doing, for the settings row.
public enum ShannonStandbyState: Equatable, Sendable {
    /// Not wanted: a switch is off, registered earphones are not connected, or a friend is present.
    case off
    /// The app keeps an audio session alive, so it can go on running in the background and speak.
    case standingBy
    /// A voice conversation or her own line is using the audio; standby takes over again afterwards.
    case inUse
    /// iOS did not let the session run (another app took the audio, or it could not be started from the
    /// background). Opening the app starts it again.
    case stopped
}

#if os(iOS)
/// iPhone standby (owner decision 2026-10-02): while registered earphones are connected and the owner
/// switched it on, the app keeps a silent, mixable playback session alive, so iOS goes on running it
/// in the background and Shannon can speak in her own voice. No notification and no CallKit is involved.
///
/// It plays silence and nothing else: other apps' audio is neither interrupted nor ducked by it, and
/// the microphone is not opened. It stops when the earphones disconnect, a switch goes off, or a
/// friend joins; iOS then suspends the app as usual. Force-quitting the app ends it. It costs battery,
/// and the settings say so.
@MainActor
public final class ShannonStandbyAudio {
    public private(set) var state: ShannonStandbyState = .off {
        didSet { if state != oldValue { stateChanged?(state) } }
    }
    public var stateChanged: (@MainActor (ShannonStandbyState) -> Void)?

    private var engine: AVAudioEngine?
    private var observers: [NSObjectProtocol] = []
    private var wanted = false
    private var sessionInUse = false
    private var speaking = false
    private var readsRoute = false

    public init() {}

    /// The app goes on running in the background while this is true.
    public var keepsAppRunning: Bool { state == .standingBy || state == .inUse }

    /// `wanted`: both switches on, registered earphones connected, nobody else present.
    /// `sessionInUse`: a voice conversation holds the audio session.
    /// `readsRoute`: the owner switched speaking on, so the route has to say where sound would come out. Without
    /// it the session is left exactly as the rest of the app set it.
    public func update(wanted: Bool, sessionInUse: Bool, readsRoute: Bool) {
        let callEnded = self.sessionInUse && !sessionInUse
        self.wanted = wanted
        self.sessionInUse = sessionInUse
        self.readsRoute = readsRoute
        guard wanted else {
            // A conversation or her own line owns the session; only the silent engine is ours to stop.
            stopEngine()
            if !sessionInUse, !speaking {
                if state != .off {
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                }
                if readsRoute { restoreRouteCategory() }
            }
            removeObservers()
            state = .off
            return
        }
        if sessionInUse || speaking {
            stopEngine()
            state = .inUse
            return
        }
        if state != .standingBy || callEnded { start() }
    }

    /// Her own line is about to be played: other audio is lowered for its length.
    public func beginSpeech() throws {
        speaking = true
        stopEngine()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
        if wanted { state = .inUse }
    }

    /// Her line ended. Standby takes over again; without standby the session is given back.
    public func endSpeech() {
        guard speaking else { return }
        speaking = false
        if wanted {
            update(wanted: true, sessionInUse: sessionInUse, readsRoute: readsRoute)
        } else if !sessionInUse {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            restoreRouteCategory()
        }
    }

    /// iOS reports the route for the session's category, also while the session is not active. A call leaves the
    /// hands-free category behind and dictation the recording one, under which stereo earphones read as the speaker or
    /// as no output at all. With nothing using the session, it is put back to plain playback, so that the route says
    /// where sound would come out. Nothing is activated by this.
    private func restoreRouteCategory() {
        let session = AVAudioSession.sharedInstance()
        guard session.category != .playback else { return }
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
    }

    /// Called when the owner opens the app: a standby iOS had stopped starts again.
    public func restartIfStopped() {
        guard wanted, !sessionInUse, !speaking, state != .standingBy || engine?.isRunning != true else { return }
        start()
    }

    private func start() {
        stopEngine()
        do {
            let session = AVAudioSession.sharedInstance()
            // Mixable: it never interrupts or lowers what the owner is listening to.
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            let engine = AVAudioEngine()
            let format = engine.outputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw URLError(.cannotDecodeRawData) }
            let silence = Self.makeSilence(format: format)
            engine.attach(silence)
            engine.connect(silence, to: engine.mainMixerNode, format: format)
            engine.prepare()
            try engine.start()
            self.engine = engine
            installObservers(for: engine)
            state = .standingBy
            ShannonVoiceDiagnostics.shared.record("standby.started")
        } catch {
            stopEngine()
            state = .stopped
            ShannonVoiceDiagnostics.shared.record("standby.start.failed", metadata: ["code": String((error as NSError).code)])
        }
    }

    /// The render block runs on Core Audio's realtime thread, so it must not inherit this class's actor.
    nonisolated private static func makeSilence(format: AVAudioFormat) -> AVAudioSourceNode {
        AVAudioSourceNode(format: format) { isSilence, _, _, outputData in
            isSilence.pointee = true
            for buffer in UnsafeMutableAudioBufferListPointer(outputData) {
                guard let data = buffer.mData else { continue }
                memset(data, 0, Int(buffer.mDataByteSize))
            }
            return noErr
        }
    }

    private func stopEngine() {
        engine?.stop()
        engine = nil
    }

    private func installObservers(for engine: AVAudioEngine) {
        removeObservers()
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: .main
        ) { [weak self] notification in
            let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            Task { @MainActor [weak self] in
                guard let self, self.wanted, !self.sessionInUse, !self.speaking,
                      let rawType, let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
                switch type {
                case .began:
                    // A phone call or another app took the audio; iOS may suspend the app until it is opened.
                    self.stopEngine()
                    self.state = .stopped
                    ShannonVoiceDiagnostics.shared.record("standby.interrupted")
                case .ended:
                    self.start()
                @unknown default:
                    break
                }
            }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: AVAudioSession.sharedInstance(), queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.wanted, !self.sessionInUse, !self.speaking else { return }
                self.start()
            }
        })
        // A change of the hardware stops the engine. Whether the new output is still his earphones is decided
        // by the route monitor, which switches standby off when it is not; here the engine only runs again.
        observers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.wanted, !self.sessionInUse, !self.speaking, self.engine?.isRunning != true else { return }
                self.start()
            }
        })
    }

    private func removeObservers() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
    }
}
#endif
