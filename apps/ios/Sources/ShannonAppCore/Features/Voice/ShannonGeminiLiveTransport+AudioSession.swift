#if os(iOS)
import Foundation
@preconcurrency import AVFoundation

/// What the system did to the call's audio. The call itself (its turns, its history) is untouched.
enum ShannonGeminiLiveAudioState: Equatable, Sendable {
    /// A phone call, Siri or another app holds the audio session. Nothing is captured or played.
    case interrupted
    /// Capture and playback run again.
    case resumed
}

/// The audio session of a voice conversation: its category, and what happens when the system
/// interrupts it or the route changes. A call either runs again or ends with a visible failure;
/// it is never left looking alive with a stopped engine.
extension ShannonGeminiLiveTransport {
    /// `.goAway` with this reason means the audio could not be brought back, not that the network dropped.
    static let audioFailure = "audio"

    func configureAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        // `playAndRecord` with the `audio` background mode keeps capture and playback running
        // after the owner leaves the app.
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try audioSession.setPreferredIOBufferDuration(0.02)
        try audioSession.setActive(true)
        try applyInputPreference()
        installAudioObservers(for: audioSession)
    }

    private func installAudioObservers(for audioSession: AVAudioSession) {
        guard audioObservers.isEmpty else { return }
        let center = NotificationCenter.default
        audioObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: audioSession, queue: .main
        ) { [weak self] notification in
            let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            Task { @MainActor [weak self] in
                guard let self, !self.stopped, let rawType,
                      let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
                switch type {
                case .began:
                    // An interruption that never reports its end (the app was suspended meanwhile) is
                    // picked up when the owner returns: `resumeAudioIfNeeded`.
                    self.beginInterruption()
                case .ended:
                    if AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) {
                        self.resumeAudio()
                    } else {
                        // The other audio did not hand the session back. The call ends where the owner can see it.
                        self.eventHandler(.goAway(Self.audioFailure))
                    }
                @unknown default:
                    break
                }
            }
        })
        audioObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: audioSession, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.stopped else { return }
                try? self.applyInputPreference()
                self.restartEngineIfStopped()
            }
        })
        // Earphones connecting or disconnecting reconfigure the hardware and stop the engine.
        audioObservers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: audioEngine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.restartEngineIfStopped() }
        })
        audioObservers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: audioSession, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.stopped else { return }
                self.eventHandler(.goAway(Self.audioFailure))
            }
        })
    }

    func removeAudioObservers() {
        audioObservers.forEach(NotificationCenter.default.removeObserver)
        audioObservers.removeAll()
    }

    /// Whether capture and playback are running. False before the first start and while interrupted.
    var isAudioRunning: Bool { audioStarted && !interrupted && audioEngine.isRunning }

    private func beginInterruption() {
        guard !interrupted else { return }
        interrupted = true
        ShannonVoiceDiagnostics.shared.record("gemini.audio.interruption.began")
        audioStateHandler(.interrupted)
    }

    /// Brings the session and the engine back after an interruption. Failing ends the call visibly, unless the
    /// caller only asked whether the interruption is over yet.
    @discardableResult
    func resumeAudio(endingCallOnFailure: Bool = true) -> Bool {
        guard !stopped else { return false }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            if audioStarted, !audioEngine.isRunning {
                try audioEngine.start()
                playerNode.play()
            }
            try applyInputPreference()
        } catch {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.resume.failed",
                metadata: ["code": String((error as NSError).code), "ending": String(endingCallOnFailure)])
            if endingCallOnFailure { eventHandler(.goAway(Self.audioFailure)) }
            return false
        }
        if interrupted {
            interrupted = false
            ShannonVoiceDiagnostics.shared.record("gemini.audio.interruption.resumed")
            audioStateHandler(.resumed)
        }
        return true
    }

    /// Called when the owner returns to the app: a call that was interrupted, or whose engine
    /// stopped while nobody was looking, runs again or fails where he can see it.
    func resumeAudioIfNeeded() {
        guard !stopped, audioStarted, !isAudioRunning else { return }
        resumeAudio()
    }

    private func restartEngineIfStopped() {
        guard !stopped, audioStarted, !interrupted, !audioEngine.isRunning else { return }
        do {
            try audioEngine.start()
            playerNode.play()
            ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.restarted")
        } catch {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.restart.failed",
                metadata: ["code": String((error as NSError).code)])
            eventHandler(.goAway(Self.audioFailure))
        }
    }

    func applyInputPreference() throws {
        let audioSession = AVAudioSession.sharedInstance()
        let inputs = audioSession.availableInputs ?? []
        let resolution = ShannonVoiceInputRouting.resolve(
            inputPreference, inputIsBuiltIn: inputs.map { $0.portType == .builtInMic }
        )
        if resolution.isPreferenceUnavailable, !preferenceUnavailable {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.input.fallback", metadata: ["preference": inputPreference.rawValue])
        }
        preferenceUnavailable = resolution.isPreferenceUnavailable
        let selected = resolution.preferredIndex.map { inputs[$0] }
        if audioSession.preferredInput?.uid != selected?.uid {
            try audioSession.setPreferredInput(selected)
        }
        publishInputState()
    }

    private func publishInputState() {
        let audioSession = AVAudioSession.sharedInstance()
        let inputs = audioSession.availableInputs ?? []
        inputStateHandler(ShannonVoiceInputState(
            preference: inputPreference,
            activeInputName: audioSession.currentRoute.inputs.first?.portName,
            isBuiltInAvailable: inputs.contains(where: { $0.portType == .builtInMic }),
            isConnectedInputAvailable: inputs.contains(where: { $0.portType != .builtInMic }),
            isPreferenceUnavailable: preferenceUnavailable
        ))
    }
}
#endif
