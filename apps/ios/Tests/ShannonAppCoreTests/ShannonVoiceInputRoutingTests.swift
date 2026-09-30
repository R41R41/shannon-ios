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
