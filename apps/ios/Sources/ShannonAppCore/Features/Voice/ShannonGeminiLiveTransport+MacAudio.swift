#if os(macOS)
@preconcurrency import AVFoundation
import AudioToolbox
import Foundation

/// The Mac has no audio session to configure, activate or be interrupted out of: the call takes the
/// microphone and the speakers through Voice Processing I/O (echo cancellation, no sidetone) as on the
/// iPhone, and Core Audio says when microphones come and go. The owner may choose one microphone by
/// name; a chosen one that is missing, or that the I/O unit refuses, never fails the call: the system's
/// input is used and the state says so.
extension ShannonGeminiLiveTransport {
    func configureAudioSession() throws {
        installMacAudioObservers()
        heardInputName = nil
        publishInputState()
    }

    func activateAudioSession() throws {}
    func deactivateAudioSession() {}

    func removePlatformAudioObservers() {
        stopObservingDevices?()
        stopObservingDevices = nil
    }

    /// Before voice processing: point the engine's input unit (still a plain HAL unit then) at the chosen
    /// microphone, on its global scope as Core Audio documents for an output unit's current device. Voice
    /// processing then builds its aggregate from that input. Nothing is set on the voice-processing unit itself.
    func prepareInputDevice() {
        appliedInputDevice = nil
        appliedInputUID = nil
        let resolution = ShannonMacVoiceInputRouting.resolve(selectedID: inputDeviceID, devices: ShannonMacAudioDevices.inputs())
        if resolution.isPreferenceUnavailable, !preferenceUnavailable {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.input.fallback", metadata: ["preference": "device"])
        }
        preferenceUnavailable = resolution.isPreferenceUnavailable
        guard let uid = resolution.deviceID, let device = ShannonMacAudioDevices.deviceID(forUID: uid),
              let unit = audioEngine.inputNode.audioUnit else { return }
        if ShannonMacAudioDevices.setCurrentDevice(device, on: unit) {
            appliedInputDevice = device
            appliedInputUID = uid
        } else {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.input.device.refused")
            preferenceUnavailable = true
        }
    }

    /// After voice processing took the unit over: say which microphone the call really hears. The unit's own
    /// device is the hidden aggregate voice processing made; its input sub-device is the microphone. When that
    /// cannot be read, the device that was set (or the system's input) is reported.
    func confirmInputDevice() {
        let heard = audioEngine.inputNode.audioUnit
            .flatMap(ShannonMacAudioDevices.currentDevice(of:))
            .flatMap { ShannonMacAudioDevices.inputBehind($0, preferring: appliedInputUID) }
        if let applied = appliedInputDevice, let heard, heard.uid != ShannonMacAudioDevices.uid(of: applied) {
            // Voice processing kept another microphone: the call goes on with it and says so.
            ShannonVoiceDiagnostics.shared.record("gemini.audio.input.device.ignored")
            preferenceUnavailable = true
        }
        heardInputName = heard?.name
        publishInputState()
    }

    /// The device is chosen when the audio starts; a later change of choice reconnects the call (the model).
    func applyInputPreference() throws {
        publishInputState()
    }

    private func installMacAudioObservers() {
        guard audioObservers.isEmpty else { return }
        // A microphone or the speakers changing under the engine stop it; it starts again, or the call fails visibly.
        audioObservers.append(NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: audioEngine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.restartEngineIfStopped() }
        })
        stopObservingDevices = ShannonMacAudioDevices.observeChanges { [weak self] in
            guard let self, !self.stopped else { return }
            // The chosen microphone went away under the running call: an audio failure, so the call reconnects
            // once onto the system's input (and says the choice cannot be used) instead of going on deaf.
            if self.audioStarted, ShannonMacVoiceInputRouting.lost(self.appliedInputUID, devices: ShannonMacAudioDevices.inputs()) {
                ShannonVoiceDiagnostics.shared.record("gemini.audio.input.device.lost")
                self.appliedInputUID = nil
                self.reportAudioFailure()
                return
            }
            try? self.applyInputPreference()
        }
    }

    private func publishInputState() {
        let devices = ShannonMacAudioDevices.inputs()
        // Never the aggregate's name: what the call hears, else what was set, else the system's input.
        let activeName = heardInputName
            ?? appliedInputDevice.flatMap(ShannonMacAudioDevices.name(of:))
            ?? ShannonMacAudioDevices.defaultInputName()
        inputStateHandler(ShannonVoiceInputState(
            preference: .automatic,
            activeInputName: activeName,
            isBuiltInAvailable: devices.contains(where: \.isBuiltIn),
            isConnectedInputAvailable: devices.contains(where: { !$0.isBuiltIn }),
            isPreferenceUnavailable: preferenceUnavailable,
            devices: devices,
            selectedDeviceID: inputDeviceID
        ))
    }
}
#endif
