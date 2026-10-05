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

    /// A completed owner reply is not interrupted by the switch; what she says about a look behind it arrives later
    /// and is spoken, but is not written on the screen the guests can read.
    func testWhatSheSaysAboutALookAfterTheSwitchIsNotShown() async {
        let model = liveModel()
        var lookResult: CheckedContinuation<String?, Never>?
        model.streamSpeech = { _, _ in throw Refused() }
        model.performAppLook = { _ in await withCheckedContinuation { lookResult = $0 } }
        model.performStreamingDelegation = { _, _, _, onSegment in
            await onSegment("見てみますね。", nil)
            var response = ShannonLiveVoiceDelegationResponseDTO(threadId: "t", model: "m", reply: "見てみますね。")
            response.appLook = ShannonAppLookAskDTO(id: "look", camera: .front, expiresAt: "2099-01-01T00:00:00Z")
            return response
        }
        model.appendUtterance(rawText: "これ見て", text: "これ見て", source: .typed)
        model.beginResponse()
        while lookResult == nil { await Task.yield() }
        XCTAssertEqual(model.shannonTranscript, "見てみますね。")
        XCTAssertNotNil(model.responseDelivery.response, "the reply is complete; the switch does not interrupt it")
        model.switchParticipantMode(to: .guest, origin: .spoken)
        XCTAssertEqual(model.shannonTranscript, "")
        lookResult?.resume(returning: "机の上に資料が見えます。")
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(model.shannonTranscript, "", "what she saw is not written for the guests")
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

    /// The owner's words from before the switch are answered, but never kept as the friend's.
    func testTheOwnersHiddenWordsAreNeverRememberedAsTheFriends() async {
        let model = liveModel()
        var sentText: String?
        model.streamSpeech = { _, _ in throw Refused() }
        model.performStreamingDelegation = { text, _, _, _ in
            sentText = text
            return ShannonLiveVoiceDelegationResponseDTO(threadId: "t", model: "m", reply: "はじめまして、ミキさん。")
        }
        model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
        model.switchParticipantMode(to: .guest, origin: .control)
        model.appendUtterance(rawText: "ミキです", text: "ミキです", source: .typed)
        model.beginResponse()
        for _ in 0..<200 where model.responseTask != nil { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(sentText, "明日の歯医者は何時？\nミキです", "his question is still answered in the call")
        let context = model.guestCall.requestContext(addressedByName: false, followsShannonTurn: false)
        XCTAssertEqual(context.turns.filter { $0.role == .participant }.map(\.text), ["ミキです"])
        XCTAssertFalse(context.turns.contains { $0.text.contains("歯医者") }, "not in the call's context")
        let period = model.guestCall.endGuestPeriod()
        XCTAssertFalse(period?.turns.contains { $0.text.contains("歯医者") } ?? true, "not in what is remembered of her")
        model.stop()
    }
}
