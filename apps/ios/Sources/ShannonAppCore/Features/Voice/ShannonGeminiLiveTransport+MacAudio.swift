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
        publishInputState(activeDevice: nil)
    }

    func activateAudioSession() throws {}
    func deactivateAudioSession() {}

    func removePlatformAudioObservers() {
        stopObservingDevices?()
        stopObservingDevices = nil
    }

    /// Before voice processing: point the input unit at the chosen microphone.
    func prepareInputDevice() {
        _ = applyChosenDevice()
    }

    /// After voice processing took the unit over: point it again, then report what it really uses.
    func confirmInputDevice() {
        let chosen = applyChosenDevice()
        let active = audioEngine.inputNode.audioUnit.flatMap(ShannonMacAudioDevices.currentDevice(of:))
        if let chosen, let active, chosen != active {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.input.device.ignored")
            preferenceUnavailable = true
        }
        publishInputState(activeDevice: active)
    }

    /// The device is chosen when the audio starts; a later change of choice reconnects the call (the model).
    func applyInputPreference() throws {
        let active = audioStarted ? audioEngine.inputNode.audioUnit.flatMap(ShannonMacAudioDevices.currentDevice(of:)) : nil
        publishInputState(activeDevice: active)
    }

    /// Sets the chosen microphone on the input unit and returns its Core Audio id, or nil for the system's input.
    private func applyChosenDevice() -> AudioDeviceID? {
        let resolution = ShannonMacVoiceInputRouting.resolve(selectedID: inputDeviceID, devices: ShannonMacAudioDevices.inputs())
        if resolution.isPreferenceUnavailable, !preferenceUnavailable {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.input.fallback", metadata: ["preference": "device"])
        }
        preferenceUnavailable = resolution.isPreferenceUnavailable
        guard let uid = resolution.deviceID, let device = ShannonMacAudioDevices.deviceID(forUID: uid),
              let unit = audioEngine.inputNode.audioUnit else { return nil }
        if !ShannonMacAudioDevices.setCurrentDevice(device, on: unit) {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.input.device.refused")
        }
        return device
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
            try? self.applyInputPreference()
        }
    }

    private func publishInputState(activeDevice: AudioDeviceID?) {
        let devices = ShannonMacAudioDevices.inputs()
        let activeName = activeDevice.flatMap(ShannonMacAudioDevices.name(of:)) ?? ShannonMacAudioDevices.defaultInputName()
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
