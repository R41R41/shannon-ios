import Foundation

/// The call's microphone: mute, and which microphone. The iPhone chooses by kind (自動・iPhone・イヤホン／外部);
/// the Mac by name, as System Settings lists them.
extension ShannonGeminiLiveSessionModel {
    public func toggleMicrophoneMute() {
        isMicrophoneMuted.toggle()
        if isMicrophoneMuted { audioLevel = 0 }
        transport?.setInputMuted(isMicrophoneMuted)
        ShannonVoiceDiagnostics.shared.record("gemini.audio.input.mute", metadata: ["muted": String(isMicrophoneMuted)])
    }

    public func selectInput(_ preference: ShannonVoiceInputPreference) {
        guard inputState.canSelect(preference) else {
            errorMessage = "選んだマイクは現在接続されていません。"
            return
        }
        do {
            try transport?.setInputPreference(preference)
            inputState = ShannonVoiceInputState(
                preference: preference,
                activeInputName: inputState.activeInputName,
                isBuiltInAvailable: inputState.isBuiltInAvailable,
                isConnectedInputAvailable: inputState.isConnectedInputAvailable,
                isPreferenceUnavailable: false
            )
            UserDefaults.standard.set(preference.rawValue, forKey: Self.inputPreferenceDefaultsKey)
        } catch {
            errorMessage = "マイクを切り替えられませんでした。接続を確認してください。"
        }
    }
}

#if os(macOS)
/// Choosing the Mac's microphone by name. The choice is kept for later calls; nil is the system's input (自動).
extension ShannonGeminiLiveSessionModel {
    static let macInputDeviceDefaultsKey = "shannon.voice.mac-input-device"

    static var storedMacInputDeviceID: String? {
        UserDefaults.standard.string(forKey: macInputDeviceDefaultsKey)
    }

    /// Lists the microphones connected now, with the one a call would use. A running call reports for itself.
    public func refreshInputDevices() {
        guard transport == nil else { return }
        let devices = ShannonMacAudioDevices.inputs()
        let selected = Self.storedMacInputDeviceID
        let resolution = ShannonMacVoiceInputRouting.resolve(selectedID: selected, devices: devices)
        let chosenName = resolution.deviceID.flatMap { id in devices.first { $0.id == id }?.name }
        inputState = ShannonVoiceInputState(
            preference: inputState.preference,
            activeInputName: chosenName ?? ShannonMacAudioDevices.defaultInputName(),
            isBuiltInAvailable: devices.contains(where: \.isBuiltIn),
            isConnectedInputAvailable: devices.contains(where: { !$0.isBuiltIn }),
            isPreferenceUnavailable: resolution.isPreferenceUnavailable,
            devices: devices,
            selectedDeviceID: selected
        )
    }

    /// Chooses the microphone. In a running call the audio has to be built again on it: the same call
    /// reconnects as after an audio failure, keeping what was said and not yet answered, the mute and the clock.
    public func selectInputDevice(_ id: String?) {
        if let id, !inputState.devices.contains(where: { $0.id == id }) {
            errorMessage = "選んだマイクは現在接続されていません。"
            return
        }
        guard id != inputState.selectedDeviceID else { return }
        if let id {
            UserDefaults.standard.set(id, forKey: Self.macInputDeviceDefaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.macInputDeviceDefaultsKey)
        }
        inputState = inputState.choosing(deviceID: id)
        ShannonVoiceDiagnostics.shared.record("gemini.audio.input.device.selected", metadata: ["automatic": String(id == nil)])
        guard transport != nil, phase != .idle, phase != .failed else { return }
        queueSameCallReconnect()
    }
}
#endif
