import XCTest
@testable import ShannonAppCore

/// A switch into 「友人も一緒」 leaves nothing of the owner's on the call's screen, however it happens.
@MainActor
final class ShannonGeminiLiveGuestScreenTests: XCTestCase {
    private struct Refused: Error {}

    private func liveModel() -> ShannonGeminiLiveSessionModel {
        let model = ShannonGeminiLiveSessionModel()
        model.phase = .listening
        return model
    }

    private func waitForFinalization(_ model: ShannonGeminiLiveSessionModel, turns: Int) async {
        for _ in 0..<200 where model.pendingTurns.turns.count < turns {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testASpokenSwitchDoesNotPutTheOwnersWordsBackOnScreen() async {
        let model = liveModel()
        model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
        model.handle(.inputTranscript("友達と一緒にいるよ。"))
        await waitForFinalization(model, turns: 2)
        XCTAssertEqual(model.participantMode, .guest)
        XCTAssertEqual(model.pendingTurns.turns.count, 2, "what he said stays pending")
        XCTAssertEqual(model.userTranscript, "", "neither his earlier question nor the switching words are shown")
        model.stop()
    }

    func testTheNextGuestUtteranceShowsOnlyTheGuestsWords() async {
        let model = liveModel()
        model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
        model.switchParticipantMode(to: .guest, origin: .control)
        model.handle(.inputTranscript("はじめまして、ミキです。"))
        XCTAssertEqual(model.userTranscript, "はじめまして、ミキです。", "the preview leaves out his pending question")
        await waitForFinalization(model, turns: 2)
        XCTAssertEqual(model.userTranscript, "はじめまして、ミキです。")
        XCTAssertEqual(model.pendingTurns.turns.count, 2)
        model.stop()
    }

    func testAnOwnerReplyStillStreamingAfterTheSwitchIsNotShown() async {
        let model = liveModel()
        var resume: CheckedContinuation<Void, Never>?
        model.streamSpeech = { _, _ in throw Refused() }
        model.performStreamingDelegation = { _, _, _, onSegment in
            await onSegment("10時です、ライ氏。", nil)
            await withCheckedContinuation { resume = $0 }
            await onSegment("それと、保険証を忘れずに。", nil)
            return ShannonLiveVoiceDelegationResponseDTO(threadId: "t", model: "m", reply: "10時です、ライ氏。それと、保険証を忘れずに。")
        }
        model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
        model.beginResponse()
        while resume == nil { await Task.yield() }
        XCTAssertEqual(model.shannonTranscript, "10時です、ライ氏。", "her owner reply was on screen")
        model.switchParticipantMode(to: .guest, origin: .control)
        XCTAssertEqual(model.shannonTranscript, "")
        resume?.resume()
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(model.shannonTranscript, "", "the rest of the owner reply does not refill the screen")
        XCTAssertFalse(model.mayShowReply(of: .owner))
        XCTAssertTrue(model.mayShowReply(of: .guest))
        model.stop()
    }

    /// The Mac's bar and the iPhone's composer both read `textSendState`: hidden owner text is never offered back.
    func testAFailedGuestReplyNeverOffersTheOwnersHiddenTextBack() async {
        let model = liveModel()
        model.streamSpeech = { _, _ in throw Refused() }
        model.performStreamingDelegation = { _, _, _, _ in throw Refused() }
        model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
        model.switchParticipantMode(to: .guest, origin: .control)
        model.beginResponse()
        for _ in 0..<200 where model.responseTask != nil { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNil(model.textSendState.failedText, "the owner's question is not shown with 入力を再送")
        XCTAssertEqual(model.pendingTurns.turns.count, 1, "it stays pending, to be answered")

        // Text the guests typed is offered back as usual.
        model.appendUtterance(rawText: "ミキです", text: "ミキです", source: .typed)
        model.beginResponse()
        for _ in 0..<200 where model.responseTask != nil { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(model.textSendState.failedText, "ミキです")
        model.stop()
    }

    func testTheIPhoneComposerLosesRestoredOwnerTextEditedOrNotWhenAFriendJoins() {
        let workspace = ShannonVoiceWorkspaceState()
        workspace.restoreFailedText("明日の歯医者は何時？", participantMode: .owner)
        XCTAssertEqual(workspace.typedMessage, "明日の歯医者は何時？")
        workspace.typedMessage += "あと保険証"
        workspace.typedMessageChanged()
        workspace.participantModeChanged(to: .guest)
        XCTAssertEqual(workspace.typedMessage, "", "edited owner text leaves too")

        // A draft he types for the guests stays; so does text restored in 「友人も一緒」.
        workspace.typedMessage = "ミキさん、ようこそ"
        workspace.typedMessageChanged()
        workspace.participantModeChanged(to: .guest)
        XCTAssertEqual(workspace.typedMessage, "ミキさん、ようこそ")
        workspace.typedMessage = ""
        workspace.typedMessageChanged()
        workspace.restoreFailedText("よろしく", participantMode: .guest)
        workspace.participantModeChanged(to: .guest)
        XCTAssertEqual(workspace.typedMessage, "よろしく")

        // Once the composer was emptied, nothing is marked any more.
        workspace.typedMessage = ""
        workspace.typedMessageChanged()
        workspace.restoreFailedText("内緒", participantMode: .owner)
        workspace.typedMessage = ""
        workspace.typedMessageChanged()
        workspace.typedMessage = "新しい下書き"
        workspace.participantModeChanged(to: .guest)
        XCTAssertEqual(workspace.typedMessage, "新しい下書き")
    }
}
