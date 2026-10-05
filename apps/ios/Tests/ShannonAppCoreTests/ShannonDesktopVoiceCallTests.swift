#if os(macOS)
import AppKit
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
        call.attach(conversation: ShannonConversationModel.designPreview(), menuBar: nil)
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
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        var line = ShannonBodyTouchCoordinator.Line(id: "l", text: "えへへ", face: nil)
        line.listenSeconds = 6
        await call.bodyListen(answersInVoice: { true })(line, 6)
        XCTAssertNil(call.workspace.connectionRequestID)
        XCTAssertEqual(call.session.phase, .idle)
        withExtendedLifetime(conversation) {}
    }

    func testTheMacStaysAwakeOnlyWhileTheCallIsLive() {
        let session = ShannonGeminiLiveSessionModel()
        XCTAssertNil(session.awakeActivity, "nothing is held before the call is ready")
        session.setKeepsScreenAwake(true)
        XCTAssertNotNil(session.awakeActivity)
        session.fail("x")
        XCTAssertNil(session.awakeActivity, "a failed call lets the Mac sleep")
        session.setKeepsScreenAwake(true)
        session.stop()
        XCTAssertNil(session.awakeActivity)
    }

    actor EndReporter: ShannonBodyCallReporting {
        var sent: [ShannonBodyCallEventDTO.Kind] = []
        func sendBodyCallEvent(scopeKey: String, event: ShannonBodyCallEventDTO) async throws { sent.append(event.type) }
    }

    func testQuittingSendsTheCallsEndBeforeTheAppIsLetGo() async {
        let presence = ShannonVoiceCallPresence.shared
        let suite = "shannon.tests.quit.\(UUID().uuidString)"
        let previousDefaults = presence.defaults
        presence.defaults = UserDefaults(suiteName: suite)!
        presence.holdBackgroundTime = { _ in {} }
        defer {
            presence.defaults = previousDefaults
            UserDefaults().removePersistentDomain(forName: suite)
        }
        let reporter = EndReporter()
        presence.configure(scopeKey: "owner", reporter: reporter, mayReport: { true })

        let call = ShannonDesktopVoiceCall()
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        // A call that was reported as started, the way beginCall wires it.
        call.session.callReported = { active in if active { presence.began(audience: .owner) } else { presence.ended() } }
        call.session.callIsReported = true
        presence.began(audience: .owner)
        call.session.phase = .speaking

        let delegate = ShannonDesktopAppDelegate()
        var sentWhenReplied: [ShannonBodyCallEventDTO.Kind]?
        let replied = expectation(description: "replied")
        delegate.replyToTerminate = { allow in
            XCTAssertTrue(allow)
            Task { sentWhenReplied = await reporter.sent; replied.fulfill() }
        }
        XCTAssertEqual(delegate.applicationShouldTerminate(NSApplication.shared), .terminateLater)
        await fulfillment(of: [replied], timeout: 5)
        XCTAssertEqual(sentWhenReplied, [.callStarted, .callEnded], "callEnded was sent before the app was let go")
        XCTAssertEqual(call.session.phase, .idle)
        withExtendedLifetime(conversation) {}
    }

    func testQuittingEndsTheCallAndWaitsAtMostTheLimit() async {
        let call = ShannonDesktopVoiceCall()
        call.attach(conversation: ShannonConversationModel.designPreview(), menuBar: nil)
        XCTAssertTrue(ShannonDesktopAppDelegate.voiceCall === call)
        call.session.phase = .speaking
        let started = ContinuousClock.now
        await call.endForQuit(limit: .milliseconds(300))
        XCTAssertEqual(call.session.phase, .idle)
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(2))
        // Without a call, quitting is not held back.
        XCTAssertEqual(ShannonDesktopAppDelegate().applicationShouldTerminate(NSApplication.shared), .terminateNow)
    }

    func testStartingACallOrDictationStopsHerEarphoneMessageAndItsAnswer() async {
        let arbiter = ShannonSpeechArbiter.shared
        let previous = arbiter.microphoneWillBeTaken
        defer { arbiter.microphoneWillBeTaken = previous }
        var taken = 0
        arbiter.microphoneWillBeTaken = { taken += 1 }
        let call = ShannonDesktopVoiceCall()
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        call.start(threadID: nil)
        XCTAssertEqual(taken, 1)
        call.end()
        call.dictationPrimaryAction { _ in }
        XCTAssertEqual(taken, 2)
        await settle()
        call.dictation.cancel()
        withExtendedLifetime(conversation) {}
    }

    func testAFinishedDictationIsNeverDroppedByACall() {
        let call = ShannonDesktopVoiceCall()
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        call.dictation.phase = .ready
        XCTAssertFalse(call.dictationHoldsMicrophone, "a stopped recorder holds no microphone")
        XCTAssertTrue(call.dictationBlocksCall)
        call.start(threadID: nil)
        XCTAssertEqual(call.dictation.phase, .ready, "the recording waits for the owner's click")
        XCTAssertNil(call.workspace.connectionRequestID, "no call began")
        XCTAssertEqual(call.session.phase, .idle)
        call.dictation.phase = .idle
        withExtendedLifetime(conversation) {}
    }

    func testAReconnectOfTheSameCallIsOneCallToTheOtherDevices() {
        let session = ShannonGeminiLiveSessionModel()
        var reports: [Bool] = []
        session.callReported = { reports.append($0) }
        session.callIsReported = true
        // Another microphone, or an audio failure: the same call reconnects and its start stays reported.
        session.stop(keepingCallReport: true)
        XCTAssertEqual(reports, [])
        XCTAssertTrue(session.callIsReported)
        // The reconnect fails: the end is reported once.
        session.fail("x")
        XCTAssertEqual(reports, [false])
        session.stop()
        XCTAssertEqual(reports, [false], "never twice")
    }

    // MARK: Elsewhere (owner decision 2026-10-06, option B)

    func testTheRowSaysTheCallAndItsPhase() {
        let call = ShannonDesktopVoiceCall()
        call.session.phase = .listening
        XCTAssertEqual(call.rowTitle, "音声会話・聞いています")
        call.session.toggleMicrophoneMute()
        XCTAssertEqual(call.rowTitle, "音声会話・ミュート中")
        XCTAssertNil(call.durationText())
        call.session.callStartedAt = Date(timeIntervalSinceNow: -192)
        XCTAssertEqual(call.durationText(), "3:12")
        XCTAssertEqual(call.spokenSummary(), "音声会話・ミュート中、通話時間 3分12秒")
    }

    func testTheCallIsInTheMenuBarOnlyWhileItIsOnAndNoWindowIsOnScreen() async {
        let menuBar = ShannonDesktopMenuBar()
        menuBar.makesStatusItem = false
        let call = ShannonDesktopVoiceCall()
        var onScreen = true
        call.windowsOnScreenProbe = { onScreen }
        call.attach(conversation: ShannonConversationModel.designPreview(), menuBar: menuBar)
        XCTAssertFalse(menuBar.isShown, "no call")

        onScreen = false
        call.updateWindowsOnScreen()
        XCTAssertFalse(call.showsInMenuBar, "a hidden window without a call shows nothing")
        XCTAssertFalse(menuBar.isShown)

        call.session.phase = .speaking
        await settle()
        XCTAssertTrue(call.showsInMenuBar)
        XCTAssertEqual(menuBar.shownButton?.title, "シャノンが話しています")
        XCTAssertEqual(menuBar.shownButton?.accessibilityLabel, "音声会話・シャノンが話しています")
        XCTAssertEqual(menuBar.currentItems().map(\.title),
                       ["音声会話・シャノンが話しています", "トークに戻る", "ミュート", "音声会話を終了する"])

        // A window back on screen takes it away; the call stays.
        onScreen = true
        call.updateWindowsOnScreen()
        XCTAssertFalse(menuBar.isShown)
        XCTAssertEqual(call.session.phase, .speaking)

        // The call ending takes it away too.
        onScreen = false
        call.updateWindowsOnScreen()
        XCTAssertTrue(menuBar.isShown)
        call.end()
        await settle()
        XCTAssertFalse(menuBar.isShown)
    }

    func testTheMenusEndItemEndsTheCall() async {
        let menuBar = ShannonDesktopMenuBar()
        menuBar.makesStatusItem = false
        let call = ShannonDesktopVoiceCall()
        call.windowsOnScreenProbe = { false }
        call.attach(conversation: ShannonConversationModel.designPreview(), menuBar: menuBar)
        call.session.phase = .listening
        await settle()
        let items = menuBar.currentItems()
        let mute = items.first { $0.title == "ミュート" }
        XCTAssertEqual(mute?.isEnabled, true)
        XCTAssertEqual(mute?.state, .off)
        _ = mute.map { NSApplication.shared.sendAction($0.action!, to: $0.target, from: $0) }
        XCTAssertTrue(call.session.isMicrophoneMuted)
        // A macOS toggle item keeps its name and shows the state with a checkmark, as the sidebar's symbol does.
        XCTAssertEqual(menuBar.currentItems()[2].title, "ミュート")
        XCTAssertEqual(menuBar.currentItems()[2].state, .on)
        let end = menuBar.currentItems().first { $0.title == "音声会話を終了する" }
        _ = end.map { NSApplication.shared.sendAction($0.action!, to: $0.target, from: $0) }
        await settle()
        XCTAssertEqual(call.session.phase, .idle)
        XCTAssertFalse(menuBar.isShown)
    }

    func testReturningToTalkPicksAWindowOfTheAppThatCanComeBack() {
        let call = ShannonDesktopVoiceCall()
        XCTAssertNil(ShannonDesktopVoiceCall.windowToReturnTo(hosts: [], last: nil), "none: a new window opens on Talk")
        let hidden = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
        let shown = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
        shown.orderFront(nil)
        defer { shown.orderOut(nil) }
        let first = UUID(), second = UUID()
        call.window(hidden, hosts: first)
        call.window(shown, hosts: second)
        XCTAssertTrue(ShannonDesktopVoiceCall.windowToReturnTo(hosts: call.rootWindows, last: hidden) === shown,
                      "a closed or ordered-out window is never picked, even if it was used last")
        XCTAssertTrue(ShannonDesktopVoiceCall.windowToReturnTo(hosts: call.rootWindows, last: shown) === shown)
        call.windowAppeared(second)
        call.windowDisappeared(second)
        XCTAssertFalse(call.rootWindows.contains { $0 === shown }, "a root view that went away hosts nothing")
    }

    func testOwnerTextThatFailedToGoIntoTheCallLeavesTheDraftWhenAFriendJoins() {
        let call = ShannonDesktopVoiceCall()
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        call.session.phase = .listening
        conversation.draft = "明日の歯医者は何時？"
        XCTAssertFalse(call.sendText(conversation.draft), "not connected: refused, the draft stays")
        conversation.draft += "あと保険証"
        call.draftChanged(conversation.draft)
        call.session.switchParticipantMode(to: .guest, origin: .spoken)
        call.participantModeChanged(to: .guest)
        XCTAssertEqual(conversation.draft, "", "edited or not, his failed text leaves")

        // A draft typed for the guests stays.
        conversation.draft = "ミキさん、ようこそ"
        call.draftChanged(conversation.draft)
        call.participantModeChanged(to: .guest)
        XCTAssertEqual(conversation.draft, "ミキさん、ようこそ")
        call.session.stop()
    }

    func testASwitchClearsTalksDraftThroughTheCallsOwnWiring() async {
        let call = ShannonDesktopVoiceCall()
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        call.start(threadID: nil)
        call.workspace.connectionRequestID = nil
        await settle()
        call.session.phase = .listening
        conversation.draft = "明日の歯医者は何時？"
        XCTAssertFalse(call.sendText(conversation.draft))
        // A spoken switch: no view is involved.
        call.session.switchParticipantMode(to: .guest, origin: .spoken)
        XCTAssertEqual(conversation.draft, "")
        call.session.stop()
    }

    private func settle() async {
        for _ in 0..<5 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
    }
}
#endif
