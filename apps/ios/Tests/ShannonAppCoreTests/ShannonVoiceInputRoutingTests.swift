import XCTest
@testable import ShannonAppCore

final class ShannonVoiceInputRoutingTests: XCTestCase {
    func testMissingEarphoneFallsBackToAutomaticInsteadOfFailing() {
        let resolution = ShannonVoiceInputRouting.resolve(.connected, inputIsBuiltIn: [true])
        XCTAssertNil(resolution.preferredIndex)
        XCTAssertTrue(resolution.isPreferenceUnavailable)
    }

    func testAvailableChoicesAreApplied() {
        XCTAssertEqual(
            ShannonVoiceInputRouting.resolve(.connected, inputIsBuiltIn: [true, false]),
            .init(preferredIndex: 1, isPreferenceUnavailable: false)
        )
        XCTAssertEqual(
            ShannonVoiceInputRouting.resolve(.builtIn, inputIsBuiltIn: [false, true]),
            .init(preferredIndex: 1, isPreferenceUnavailable: false)
        )
        XCTAssertEqual(
            ShannonVoiceInputRouting.resolve(.automatic, inputIsBuiltIn: []),
            .init(preferredIndex: nil, isPreferenceUnavailable: false)
        )
        XCTAssertTrue(ShannonVoiceInputRouting.resolve(.builtIn, inputIsBuiltIn: []).isPreferenceUnavailable)
    }

    func testLabelNamesTheMicrophoneActuallyInUseAndTheMissingChoice() {
        let fallback = ShannonVoiceInputState(
            preference: .connected, activeInputName: "iPhoneマイク", isPreferenceUnavailable: true
        )
        XCTAssertEqual(fallback.activeInputLabel, "使用中: iPhoneマイク（イヤホン／外部マイクが未接続）")
        XCTAssertEqual(ShannonVoiceInputState(preference: .connected, activeInputName: "AirPods").activeInputLabel, "使用中: AirPods")
        XCTAssertEqual(ShannonVoiceInputState().activeInputLabel, "入力を確認中")
    }
}

/// The Mac chooses its microphone by name; a missing one never fails the call.
final class ShannonMacVoiceInputRoutingTests: XCTestCase {
    private let devices = [
        ShannonVoiceInputDevice(id: "BuiltInMicrophoneDevice", name: "MacBook Proのマイク", isBuiltIn: true),
        ShannonVoiceInputDevice(id: "usb-mic", name: "USBマイク", isBuiltIn: false),
    ]

    func testTheSystemInputIsUsedUnlessAConnectedMicrophoneWasChosen() {
        XCTAssertEqual(
            ShannonMacVoiceInputRouting.resolve(selectedID: nil, devices: devices),
            .init(deviceID: nil, isPreferenceUnavailable: false))
        XCTAssertEqual(
            ShannonMacVoiceInputRouting.resolve(selectedID: "usb-mic", devices: devices),
            .init(deviceID: "usb-mic", isPreferenceUnavailable: false))
        // Unplugged: the system's input for this call, and the choice is said to be unavailable.
        XCTAssertEqual(
            ShannonMacVoiceInputRouting.resolve(selectedID: "usb-mic", devices: [devices[0]]),
            .init(deviceID: nil, isPreferenceUnavailable: true))
    }

    func testTheLabelSaysWhenTheChosenMicrophoneCannotBeUsed() {
        let state = ShannonVoiceInputState(
            activeInputName: "MacBook Proのマイク", isPreferenceUnavailable: true, devices: devices, selectedDeviceID: "usb-mic")
        XCTAssertEqual(state.activeInputLabel, "使用中: MacBook Proのマイク（選んだマイクを使えません）")
        let chosen = state.choosing(deviceID: nil)
        XCTAssertFalse(chosen.isPreferenceUnavailable)
        XCTAssertNil(chosen.selectedDeviceID)
        XCTAssertEqual(chosen.devices, devices)
    }

#if os(macOS)
    @MainActor
    func testAChoiceIsKeptForLaterCallsAndAMissingOneIsRefused() {
        let key = ShannonGeminiLiveSessionModel.macInputDeviceDefaultsKey
        let previous = UserDefaults.standard.string(forKey: key)
        defer {
            if let previous { UserDefaults.standard.set(previous, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.removeObject(forKey: key)
        let model = ShannonGeminiLiveSessionModel()
        model.inputState = ShannonVoiceInputState(devices: devices)
        model.selectInputDevice("gone")
        XCTAssertEqual(model.errorMessage, "選んだマイクは現在接続されていません。")
        XCTAssertNil(UserDefaults.standard.string(forKey: key))

        model.selectInputDevice("usb-mic")
        XCTAssertEqual(model.inputState.selectedDeviceID, "usb-mic")
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), "usb-mic")
        // Without a call nothing reconnects.
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(ShannonGeminiLiveSessionModel().inputState.selectedDeviceID, "usb-mic")

        model.selectInputDevice(nil)
        XCTAssertNil(UserDefaults.standard.string(forKey: key))
    }
#endif
}
