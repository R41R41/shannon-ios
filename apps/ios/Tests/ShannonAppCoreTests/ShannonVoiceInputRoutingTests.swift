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

    func testAChosenMicrophoneThatGoesAwayMidCallIsLost() {
        XCTAssertFalse(ShannonMacVoiceInputRouting.lost(nil, devices: []), "the system's input is never lost this way")
        XCTAssertFalse(ShannonMacVoiceInputRouting.lost("usb-mic", devices: devices))
        XCTAssertTrue(ShannonMacVoiceInputRouting.lost("usb-mic", devices: [devices[0]]))
    }

    func testALiveCallThatHearsNoBuffersIsDeaf() {
        var watch = ShannonVoiceCaptureWatch()
        XCTAssertFalse(watch.isDeaf(at: 100), "not watched")
        watch.buffer(at: 100)
        XCTAssertNil(watch.lastBufferAt, "buffers before the watch are not counted")
        watch.start(at: 100)
        XCTAssertFalse(watch.isDeaf(at: 105))
        XCTAssertTrue(watch.isDeaf(at: 106.5), "started but deaf")
        watch.buffer(at: 106)
        XCTAssertFalse(watch.isDeaf(at: 111))
        XCTAssertTrue(watch.isDeaf(at: 112.5))
        watch.stop()
        XCTAssertFalse(watch.isDeaf(at: 200))
    }

    func testAnEngineThatKeepsStoppingIsNotRestartedInPlaceForEver() {
        var budget = ShannonVoiceEngineRestartBudget()
        XCTAssertTrue(budget.allows(at: 0))
        XCTAssertTrue(budget.allows(at: 1))
        XCTAssertTrue(budget.allows(at: 2))
        XCTAssertFalse(budget.allows(at: 3), "the fourth within ten seconds goes to the bounded reconnect")
        XCTAssertTrue(budget.allows(at: 11), "the window moves on")
    }

    @MainActor
    func testASecondAudioFailureSoonAfterIsShownInsteadOfReconnectingAgain() {
        let model = ShannonGeminiLiveSessionModel()
        model.phase = .listening
        model.lastAudioReconnectAt = Date()
        model.audioFailed()
        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.failureRecovery, .reconnect)
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
    /// Whatever this Mac has: the list and the 自動 label never show voice processing's hidden aggregate.
    func testTheMicrophonesListedAreNeverTheVoiceProcessingAggregate() {
        for device in ShannonMacAudioDevices.inputs() {
            XCTAssertFalse(device.id.hasPrefix("VPAUAggregateAudioDevice"))
            XCTAssertEqual(ShannonMacAudioDevices.deviceID(forUID: device.id).flatMap(ShannonMacAudioDevices.inputBehind)?.uid, device.id)
        }
        XCTAssertFalse(ShannonMacAudioDevices.defaultInputName()?.hasPrefix("VPAUAggregateAudioDevice") ?? false)
    }

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
