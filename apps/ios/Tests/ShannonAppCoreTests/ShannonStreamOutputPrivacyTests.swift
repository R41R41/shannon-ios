#if os(macOS)
import AppKit
import XCTest
@testable import ShannonAppCore

/// Roadmap A18 S5, owner decisions of 2026-10-06: while 配信用の出力（OBS） is on, the Mac's voice conversation is
/// 「友人も一緒」.
@MainActor
final class ShannonStreamOutputPrivacyTests: XCTestCase {
    func testACallStartsInFriendsModeOnlyWhileTheStreamOutputIsOn() {
        XCTAssertEqual(ShannonDesktopVoiceCall.startingMode(streamOutputOn: true), .guest)
        XCTAssertEqual(ShannonDesktopVoiceCall.startingMode(streamOutputOn: false), .owner)

        let call = ShannonDesktopVoiceCall()
        call.streamOutputIsOn = { true }
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        conversation.draft = "明日の歯医者は何時？"
        call.start(threadID: nil)
        call.workspace.connectionRequestID = nil
        // His draft was typed before the call: set aside, as when a friend joins.
        XCTAssertEqual(conversation.draft, "")
        XCTAssertEqual(call.ownerDraftAside, "明日の歯医者は何時？")
        call.end()
        XCTAssertEqual(conversation.draft, "明日の歯医者は何時？")
    }

    func testTurningTheStreamOutputOnMovesACallToFriendsModeAndHoldsItThere() async {
        var streaming = false
        let call = ShannonDesktopVoiceCall()
        call.streamOutputIsOn = { streaming }
        let conversation = ShannonConversationModel.designPreview()
        call.attach(conversation: conversation, menuBar: nil)
        call.start(threadID: nil)
        call.workspace.connectionRequestID = nil
        await settle()
        call.session.phase = .listening
        XCTAssertEqual(call.session.participantMode, .owner)
        conversation.draft = "ライ氏だけの話"

        streaming = true
        NotificationCenter.default.post(name: .shannonStreamOutputChanged, object: nil, userInfo: [ShannonStreamOutput.isOnKey: true])
        XCTAssertEqual(call.session.participantMode, .guest)
        XCTAssertTrue(call.session.hidesOwnerScreens)
        XCTAssertEqual(conversation.draft, "", "his draft is not left for the people watching")
        XCTAssertTrue(call.participantIsHeldForStream)

        // 本人だけ is refused while the stream output is on.
        call.switchParticipant(to: .owner)
        XCTAssertEqual(call.session.participantMode, .guest)

        // Turned off: the call stays as it is, and the owner may go back himself.
        streaming = false
        NotificationCenter.default.post(name: .shannonStreamOutputChanged, object: nil, userInfo: [ShannonStreamOutput.isOnKey: false])
        XCTAssertEqual(call.session.participantMode, .guest)
        XCTAssertFalse(call.participantIsHeldForStream)
        call.switchParticipant(to: .owner)
        XCTAssertEqual(call.session.participantMode, .owner)
        XCTAssertEqual(conversation.draft, "ライ氏だけの話")
        call.end()
    }

    func testACallIsReportedAsHeardByOthersWhileTheStreamOutputIsOn() {
        XCTAssertEqual(ShannonVoiceWorkspaceState.callAudience(.owner, streamOutputOn: true), .others)
        XCTAssertEqual(ShannonVoiceWorkspaceState.callAudience(.guest, streamOutputOn: true), .others)
        XCTAssertEqual(ShannonVoiceWorkspaceState.callAudience(.guest, streamOutputOn: false), .others)
        XCTAssertEqual(ShannonVoiceWorkspaceState.callAudience(.owner, streamOutputOn: false), .owner)
        XCTAssertEqual(ShannonVoiceWorkspaceState.callAudience(nil, streamOutputOn: false), .owner)
    }

    func testAnIdleCallIsNotTouchedWhenTheStreamOutputIsTurnedOn() {
        let call = ShannonDesktopVoiceCall()
        call.streamOutputIsOn = { true }
        call.attach(conversation: ShannonConversationModel.designPreview(), menuBar: nil)
        call.streamOutputTurnedOn()
        XCTAssertEqual(call.session.phase, .idle)
        XCTAssertEqual(call.session.participantMode, .owner)
    }

    func testTheSwitchIsAnnouncedWhenItChanges() {
        let output = ShannonStreamOutput(defaults: UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!, port: 0, files: { nil })
        let heard = Heard()
        let observer = NotificationCenter.default.addObserver(forName: .shannonStreamOutputChanged, object: output, queue: nil) { note in
            heard.values.append(note.userInfo?[ShannonStreamOutput.isOnKey] as? Bool ?? false)
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        // It cannot start here (no page): it goes back off and says so too.
        output.setOn(true)
        XCTAssertEqual(heard.values.last, false)
        XCTAssertFalse(output.isOn)
    }

    // MARK: Screen capture

    func testTheAppsWindowsAreLeftOutOfScreenCaptureWhileItIsOnButHerDesktopBodyIsNot() {
        let talk = NSWindow(contentRect: .init(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        let alreadyHidden = NSWindow(contentRect: .init(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        alreadyHidden.sharingType = .none
        let body = ShannonDesktopBodyPanel(contentRect: .init(x: 0, y: 0, width: 100, height: 100), styleMask: [.borderless], backing: .buffered, defer: true)
        talk.isReleasedWhenClosed = false
        alreadyHidden.isReleasedWhenClosed = false
        body.isReleasedWhenClosed = false
        XCTAssertFalse(ShannonStreamOutputWindowCapture.hides(isDesktopBody: true))
        XCTAssertTrue(ShannonStreamOutputWindowCapture.hides(isDesktopBody: false))

        let capture = ShannonStreamOutputWindowCapture()
        capture.windows = { [talk, alreadyHidden, body] }
        let output = ShannonStreamOutput(defaults: UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!, port: 0, capture: capture)
        output.setOn(true)
        defer { output.setOn(false) }
        XCTAssertTrue(capture.isHiding)
        XCTAssertEqual(talk.sharingType, .none)
        XCTAssertEqual(body.sharingType, .readOnly, "her desktop body stays capturable")
        // A window opened while it is on is covered when it comes on screen.
        let settings = NSWindow(contentRect: .init(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        settings.isReleasedWhenClosed = false
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: settings)
        XCTAssertEqual(settings.sharingType, .none)

        output.setOn(false)
        XCTAssertFalse(capture.isHiding)
        XCTAssertEqual(talk.sharingType, .readOnly)
        XCTAssertEqual(settings.sharingType, .readOnly)
        XCTAssertEqual(alreadyHidden.sharingType, .none, "a window that was hidden before stays hidden")
        // Off: a new window is left alone.
        let later = NSWindow(contentRect: .init(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        later.isReleasedWhenClosed = false
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: later)
        XCTAssertEqual(later.sharingType, .readOnly)
    }

    private final class Heard: @unchecked Sendable {
        var values: [Bool] = []
    }

    private func settle() async {
        for _ in 0..<5 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
    }
}
#endif
