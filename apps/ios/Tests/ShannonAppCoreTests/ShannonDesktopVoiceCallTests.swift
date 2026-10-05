#if os(macOS)
import XCTest
@testable import ShannonAppCore

/// The Mac's voice conversation (roadmap A16): what the app adds around the iPhone's call.
@MainActor
final class ShannonDesktopVoiceCallTests: XCTestCase {
    func testTheCallEndsOnlyWhenItsLastWindowIsGone() async {
        let call = ShannonDesktopVoiceCall()
        call.lastWindowGrace = .zero
        let first = UUID(), second = UUID()
        call.windowAppeared(first)
        call.windowAppeared(second)
        call.session.phase = .listening
        XCTAssertTrue(call.isShown)

        call.windowDisappeared(first)
        await settle()
        XCTAssertEqual(call.session.phase, .listening, "another window still shows the call")

        call.windowDisappeared(second)
        await settle()
        XCTAssertEqual(call.session.phase, .idle)
        XCTAssertEqual(call.windowCount, 0)
    }

    func testAWindowRebuiltInPlaceDoesNotEndTheCall() async {
        let call = ShannonDesktopVoiceCall()
        call.lastWindowGrace = .milliseconds(50)
        let window = UUID()
        call.windowAppeared(window)
        call.session.phase = .speaking
        call.windowDisappeared(window)
        call.windowAppeared(window)
        try? await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(call.session.phase, .speaking)
    }

    func testAFailedCallIsShownButHoldsNoMicrophone() {
        let call = ShannonDesktopVoiceCall()
        XCTAssertFalse(call.isShown)
        call.session.phase = .failed
        XCTAssertTrue(call.isShown)
        XCTAssertFalse(call.holdsMicrophone)
        XCTAssertFalse(call.dictationWaitsForCall)
        call.session.phase = .listening
        XCTAssertTrue(call.holdsMicrophone)
        // Dictation does not start while the call holds the microphone.
        XCTAssertTrue(call.dictationWaitsForCall)
    }

    func testWhileACallOrDictationHoldsTheMicrophoneNothingElseOfHersSpeaks() {
        let call = ShannonDesktopVoiceCall()
        call.attach(conversation: ShannonConversationModel.designPreview())
        let arbiter = ShannonSpeechArbiter.shared
        XCTAssertEqual(arbiter.sessionInUse?(), false)
        XCTAssertFalse(arbiter.isBusyForTouchLine)
        call.session.phase = .thinking
        XCTAssertEqual(arbiter.sessionInUse?(), true)
        XCTAssertTrue(arbiter.isBusyForTouchLine)
        call.session.phase = .failed
        XCTAssertEqual(arbiter.sessionInUse?(), false)
    }

    func testEndingTheCallClearsAnUnsharedPhotoAndAFriendNeverSharesOne() {
        let call = ShannonDesktopVoiceCall()
        XCTAssertTrue(call.canSharePhoto)
        call.workspace.pendingCameraData = Data([1, 2, 3])
        call.workspace.cameraErrorMessage = "x"
        call.clearPendingPhoto()
        XCTAssertNil(call.workspace.pendingCameraData)
        XCTAssertNil(call.workspace.cameraErrorMessage)
        call.session.participantMode = .guest
        XCTAssertFalse(call.canSharePhoto)
        // A photo that arrives in 「友人も一緒」 is not kept for sharing.
        call.workspace.threadContext = ShannonVoiceThreadContext(threadID: "t")
        call.receiveCameraFrame(Data([0xFF, 0xD8]))
        XCTAssertNil(call.workspace.pendingCameraData)
    }

    func testHerFigureShowsTheCallsPhaseAsTheIPhoneCallScreenDoes() {
        XCTAssertEqual(ShannonTalkFigurePanel.callActivity(.listening), .listening)
        XCTAssertEqual(ShannonTalkFigurePanel.callActivity(.thinking), .thinking)
        XCTAssertEqual(ShannonTalkFigurePanel.callActivity(.connecting), .thinking)
        XCTAssertEqual(ShannonTalkFigurePanel.callActivity(.reconnecting), .thinking)
        XCTAssertEqual(ShannonTalkFigurePanel.callActivity(.speaking), .speaking)
        XCTAssertEqual(ShannonTalkFigurePanel.callActivity(.failed), .idle)
    }

    func testATouchLineIsNotListenedForInADesignPreviewOrWhenTheBodyNoLongerAnswersInVoice() async {
        let call = ShannonDesktopVoiceCall()
        call.attach(conversation: ShannonConversationModel.designPreview())
        var line = ShannonBodyTouchCoordinator.Line(id: "l", text: "えへへ", face: nil)
        line.listenSeconds = 6
        await call.bodyListen(answersInVoice: { true })(line, 6)
        XCTAssertNil(call.workspace.connectionRequestID)
        XCTAssertEqual(call.session.phase, .idle)
    }

    private func settle() async {
        for _ in 0..<5 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
    }
}
#endif
