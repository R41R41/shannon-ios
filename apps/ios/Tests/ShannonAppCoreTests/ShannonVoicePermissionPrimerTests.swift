#if os(iOS)
import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonVoicePermissionPrimerTests: XCTestCase {
    func testGrantedMicrophoneSkipsPrimer() async {
        let model = ShannonGeminiLiveSessionModel()
        model.microphonePermission = { .granted }
        let passed = await model.passMicrophonePrimer(generation: UUID())
        XCTAssertTrue(passed)
        XCTAssertNil(model.microphonePrimerPhase)
    }

    func testDeniedMicrophoneShowsSettingsStateWithoutRequesting() async {
        let model = ShannonGeminiLiveSessionModel()
        model.microphonePermission = { .denied }
        let passed = await model.passMicrophonePrimer(generation: UUID())
        XCTAssertFalse(passed)
        XCTAssertEqual(model.microphonePrimerPhase, .denied)
        XCTAssertEqual(model.failureRecovery, .openSettings)
        model.dismissMicrophonePrimer()
        XCTAssertNil(model.microphonePrimerPhase)
    }

    func testUndeterminedMicrophoneWaitsForUserAndStopDeclines() async {
        let model = ShannonGeminiLiveSessionModel()
        model.microphonePermission = { .undetermined }
        let gate = Task { await model.passMicrophonePrimer(generation: UUID()) }
        while model.microphonePrimerPhase != .explain { await Task.yield() }
        model.stop()
        let passed = await gate.value
        XCTAssertFalse(passed)
        XCTAssertNil(model.microphonePrimerPhase)
    }

    func testConfirmForStaleSessionDoesNotRequest() async {
        let model = ShannonGeminiLiveSessionModel()
        model.microphonePermission = { .undetermined }
        let gate = Task { await model.passMicrophonePrimer(generation: UUID()) }
        while model.microphonePrimerPhase != .explain { await Task.yield() }
        model.confirmMicrophonePrimer()
        let passed = await gate.value
        XCTAssertFalse(passed, "A primer for a session that no longer exists must not reach the system request")
    }
}
#endif
