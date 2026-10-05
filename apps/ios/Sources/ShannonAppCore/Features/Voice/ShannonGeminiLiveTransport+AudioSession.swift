import Foundation
@preconcurrency import AVFoundation

/// What the system did to the call's audio. The call itself (its turns, its history) is untouched.
enum ShannonGeminiLiveAudioState: Equatable, Sendable {
    /// A phone call, Siri or another app holds the audio session. Nothing is captured or played.
    case interrupted
    /// Capture and playback run again.
    case resumed
}

/// What happens when the system interrupts a call's audio or the hardware changes under it. A call either
/// runs again or ends with a visible failure; it is never left looking alive with a stopped engine.
/// The iPhone's audio session lives below; the Mac has none (`ShannonGeminiLiveTransport+MacAudio.swift`).
extension ShannonGeminiLiveTransport {
    /// `.goAway` with this reason means the audio could not be brought back, not that the network dropped.
    static let audioFailure = "audio"

    /// Tells the call once that its audio cannot be kept running; later failures of this transport add nothing.
    func reportAudioFailure() {
        guard !reportedAudioFailure, !stopped else { return }
        reportedAudioFailure = true
        eventHandler(.goAway(Self.audioFailure))
    }

    func removeAudioObservers() {
        audioObservers.forEach(NotificationCenter.default.removeObserver)
        audioObservers.removeAll()
        removePlatformAudioObservers()
    }

    /// Whether capture and playback are running. False before the first start and while interrupted.
    var isAudioRunning: Bool { audioStarted && !interrupted && audioEngine.isRunning }

    func beginInterruption() {
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
            try activateAudioSession()
        } catch {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.resume.refused",
                metadata: ["code": String((error as NSError).code), "ending": String(endingCallOnFailure)])
            // The session could not be taken back: for a caller that only asks, the interruption is simply still going on.
            if endingCallOnFailure { reportAudioFailure() }
            return false
        }
        do {
            if audioStarted, !audioEngine.isRunning {
                try audioEngine.start()
                playerNode.play()
            }
            try applyInputPreference()
        } catch {
            // The session is ours again and the audio still does not run: that is a failure, never "still interrupted".
            ShannonVoiceDiagnostics.shared.record("gemini.audio.resume.failed",
                metadata: ["code": String((error as NSError).code)])
            reportAudioFailure()
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

    func restartEngineIfStopped() {
        guard !stopped, audioStarted, !interrupted, !audioEngine.isRunning else { return }
        // An engine that keeps stopping is not restarted in place for ever: the call's bounded reconnect
        // takes over, and a second failure soon after is shown.
        guard engineRestarts.allows(at: ProcessInfo.processInfo.systemUptime) else {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.restart.exhausted")
            reportAudioFailure()
            return
        }
        do {
            try audioEngine.start()
            playerNode.play()
            ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.restarted")
        } catch {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.restart.failed",
                metadata: ["code": String((error as NSError).code)])
            reportAudioFailure()
        }
    }
}

/// How often an engine may be started again in place. Only an engine that stops again soon after being restarted
/// counts: after `limit` such restarts in a row the call's bounded reconnect takes over. An engine that ran for
/// `healthyRun` seconds after its last restart was healthy, and the next stop starts a new count, so earphones or
/// AirPods that change the route now and then never use the budget up.
struct ShannonVoiceEngineRestartBudget: Equatable, Sendable {
    static let limit = 3
    /// The capture watch's own limit: a live engine that ran this long without stopping delivered its buffers
    /// (were it deaf, the watch would have ended it as an audio failure by then).
    static let healthyRun: TimeInterval = ShannonVoiceCaptureWatch.limit
    private(set) var count = 0
    private(set) var lastRestartAt: TimeInterval?

    /// Counts one restart at `now` and says whether it may happen.
    mutating func allows(at now: TimeInterval) -> Bool {
        if let last = lastRestartAt, now - last >= Self.healthyRun { count = 0 }
        guard count < Self.limit else { return false }
        count += 1
        lastRestartAt = now
        return true
    }
}

#if os(iOS)
/// The iPhone's audio session of a voice conversation: its category, interruptions and route changes.
extension ShannonGeminiLiveTransport {
    func configureAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        // `playAndRecord` with the `audio` background mode keeps capture and playback running
        // after the owner leaves the app.
        // A call from Shannon the owner answered is the system's call: the phone routes it as it routes any call
        // (the receiver without earphones), so the speaker is not forced, and the session is already active.
        let systemCall = ShannonVoiceCallHost.shared.systemCallIsActive
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: systemCall ? [.allowBluetoothHFP] : [.defaultToSpeaker, .allowBluetoothHFP]
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
                        self.reportAudioFailure()
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
                self.reportAudioFailure()
            }
        })
    }

    func activateAudioSession() throws {
        try AVAudioSession.sharedInstance().setActive(true)
    }

    func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The device has no Core Audio listeners of its own: everything is a notification.
    func removePlatformAudioObservers() {}

    /// The iPhone chooses its microphone through the session's preferred input, not on the I/O unit.
    func prepareInputDevice() {}
    func confirmInputDevice() {}

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
