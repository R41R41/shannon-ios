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
        // After the moments in which what is recognised is still his (`ownerWordsAfterSwitch`).
        try? await Task.sleep(for: .seconds(ShannonGeminiLiveSessionModel.ownerWordsAfterSwitch + 0.1))
        model.handle(.inputTranscript("はじめまして、ミキです。"))
        XCTAssertEqual(model.userTranscript, "はじめまして、ミキです。", "the preview leaves out his pending question")
        await waitForFinalization(model, turns: 2)
        XCTAssertEqual(model.userTranscript, "はじめまして、ミキです。")
        XCTAssertEqual(model.pendingTurns.turns.count, 2)
        model.stop()
    }

    /// The production order: the owner reply completes and is on screen, the look starts while it is spoken, the
    /// owner confirms 友人も一緒 by the control while she waits for what she saw, and then her line about it arrives.
    /// It is spoken (sent for speech) but not written on the screen the guests can read.
    func testWhatSheSaysAboutALookAfterTheSwitchIsSpokenButNotShown() async {
        let model = liveModel()
        var lookResult: CheckedContinuation<String?, Never>?
        var sentForSpeech: [String] = []
        model.streamSpeech = { text, _ in
            sentForSpeech.append(text)
            throw Refused()
        }
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
        model.switchParticipantMode(to: .guest, origin: .control)
        XCTAssertEqual(model.shannonTranscript, "")
        lookResult?.resume(returning: "机の上に資料が見えます。")
        // The look line must arrive; the test fails if it never does.
        for _ in 0..<200 where !sentForSpeech.contains(where: { $0.contains("資料") }) {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(sentForSpeech.contains { $0.contains("資料") }, "her line about the look was spoken")
        XCTAssertEqual(model.shannonTranscript, "", "but not written for the guests")
        model.stop()
    }

    /// A guest reply that fails after a sentence was played keeps the spoken part (`keepSpokenPart`): for the guests,
    /// their own words and that part; with the owner's hidden words in the batch, their words only.
    func testAKeptSpokenPartIsRecordedForTheGuestsOnly() async {
        for withOwnerWords in [false, true] {
            let model = liveModel()
            model.streamSpeech = { _, _ in throw Refused() }
            model.performStreamingDelegation = { [unowned model] _, _, _, onSegment in
                await onSegment("はじめまして、ミキさん。", nil)
                model.responseDelivery.spoken.played("はじめまして、ミキさん。")
                throw Refused()
            }
            if withOwnerWords {
                model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
            }
            model.switchParticipantMode(to: .guest, origin: .spoken)
            model.appendUtterance(rawText: "ミキです", text: "ミキです", source: .typed)
            model.beginResponse()
            for _ in 0..<200 where model.responseTask != nil { try? await Task.sleep(for: .milliseconds(5)) }
            XCTAssertTrue(model.responseDelivery.keptSpokenPart, "the spoken part was kept")
            let turns = model.guestCall.requestContext(addressedByName: false, followsShannonTurn: false).turns
            XCTAssertEqual(turns.filter { $0.role == .participant }.map(\.text), ["ミキです"])
            XCTAssertFalse(turns.contains { $0.text.contains("歯医者") })
            XCTAssertEqual(turns.contains { $0.role == .shannon }, !withOwnerWords)
            model.stop()
        }
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
        XCTAssertEqual(context.turns.filter { $0.role == .shannon }, [], "her reply also answered him: not kept as the friend's call")
        XCTAssertFalse(model.guestCall.needsIntroduction)
        XCTAssertFalse(context.turns.contains { $0.text.contains("歯医者") }, "not in the call's context")
        let period = model.guestCall.endGuestPeriod()
        XCTAssertFalse(period?.turns.contains { $0.text.contains("歯医者") } ?? true, "not in what is remembered of her")
        model.stop()
    }

    /// Her reply to his hidden question carries his content; with no words of the guests in that batch nothing is kept.
    func testAnExchangeThatAnsweredOnlyTheOwnerKeepsNothingButTheGreetingIsDone() async {
        let model = liveModel()
        model.streamSpeech = { _, _ in throw Refused() }
        model.performStreamingDelegation = { _, _, _, _ in
            ShannonLiveVoiceDelegationResponseDTO(threadId: "t", model: "m", reply: "歯医者は明日の10時です。")
        }
        model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
        model.switchParticipantMode(to: .guest, origin: .spoken)
        XCTAssertTrue(model.guestCall.needsIntroduction)
        model.beginResponse()
        for _ in 0..<200 where model.responseTask != nil { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(model.guestCall.requestContext(addressedByName: false, followsShannonTurn: false).turns, [])
        XCTAssertFalse(model.guestCall.needsIntroduction)
        XCTAssertNil(model.guestCall.endGuestPeriod().flatMap { $0.turns.isEmpty ? nil : $0 }, "nothing to remember")

        // A later exchange of the guests alone keeps both sides as before.
        var guest = ShannonVoiceGuestCallState()
        guest.beginGuestPeriod()
        guest.record(participant: "ミキです", shannon: "はじめまして。")
        XCTAssertEqual(guest.requestContext(addressedByName: false, followsShannonTurn: false).turns.map(\.text), ["ミキです", "はじめまして。"])
        model.stop()
    }

    /// What he was saying at the tap (being assembled, or still being recognised) is his: shown nowhere, not the guests'.
    func testOwnerSpeechInFlightAtTheControlSwitchStaysHis() async {
        let model = liveModel()
        model.handle(.inputTranscript("明日の予定は"))
        model.switchParticipantMode(to: .guest, origin: .control)
        XCTAssertEqual(model.userTranscript, "")
        // Recognised just after the tap: still his.
        model.handle(.inputTranscript("歯医者だっけ。"))
        XCTAssertEqual(model.userTranscript, "", "the preview does not show it")
        await waitForFinalization(model, turns: 1)
        XCTAssertEqual(model.pendingTurns.turns.count, 1, "answered in the call")
        XCTAssertEqual(model.userTranscript, "")
        XCTAssertEqual(model.pendingTurns.displayText, "", "and never shown")

        // Once the window has passed, the guests' words are theirs.
        try? await Task.sleep(for: .seconds(ShannonGeminiLiveSessionModel.ownerWordsAfterSwitch + 0.1))
        model.handle(.inputTranscript("はじめまして。"))
        XCTAssertEqual(model.userTranscript, "はじめまして。")
        await waitForFinalization(model, turns: 2)
        XCTAssertEqual(model.pendingTurns.displayText, "はじめまして。")
        model.stop()
    }

    /// While a call is in 「友人も一緒」 (also failed or reconnecting) the owner's screens are covered; never otherwise.
    func testTheOwnersScreensAreCoveredExactlyWhileAFriendIsInTheCall() {
        let model = ShannonGeminiLiveSessionModel()
        XCTAssertFalse(model.hidesOwnerScreens)
        model.phase = .listening
        XCTAssertFalse(model.hidesOwnerScreens, "本人だけ")
        model.switchParticipantMode(to: .guest, origin: .spoken)
        XCTAssertTrue(model.hidesOwnerScreens)
        model.phase = .failed
        XCTAssertTrue(model.hidesOwnerScreens, "a failed call on screen is still the friend's call")
        model.stop()
        XCTAssertFalse(model.hidesOwnerScreens, "the call ended")
        XCTAssertEqual(ShannonGeneratedStrings.voiceGuestHidesTalk, "友人も一緒の通話中は、トークを隠しています")
    }

    /// iPhone: everything in the call's composer when a friend joins was typed outside 「友人も一緒」: it is set aside,
    /// not deleted, through the call's own wiring (no view), and comes back with 本人だけ or the end of the call.
    func testTheIPhoneComposerSetsTheOwnersTextAsideWhileAFriendIsThere() {
        let workspace = ShannonVoiceWorkspaceState()
        let model = ShannonGeminiLiveSessionModel()
        let conversation = ShannonConversationModel.designPreview()
        _ = workspace.beginCall(mode: .owner, speechProvider: .gemini, threadID: nil,
            conversationModel: conversation, geminiVoiceModel: model)
        workspace.connectionRequestID = nil
        model.phase = .listening
        workspace.typedMessage = "明日の歯医者は何時？"
        workspace.pendingCameraData = Data([1])
        model.switchParticipantMode(to: .guest, origin: .spoken)
        XCTAssertEqual(workspace.typedMessage, "", "not shown, not sent as the guests' words")
        XCTAssertNil(workspace.pendingCameraData)
        workspace.typedMessage = "ミキさん、ようこそ"
        model.switchParticipantMode(to: .owner)
        XCTAssertEqual(workspace.typedMessage, "明日の歯医者は何時？\nミキさん、ようこそ", "his comes back; the guests' draft stays")

        // A failed text he typed and the end of the call.
        workspace.typedMessage = ""
        workspace.restoreFailedText("保険証は？", participantMode: .owner)
        model.switchParticipantMode(to: .guest, origin: .spoken)
        XCTAssertEqual(workspace.typedMessage, "")
        workspace.endCall(model)
        XCTAssertEqual(workspace.typedMessage, "保険証は？")
        XCTAssertNil(workspace.ownerMessageAside)
        withExtendedLifetime(conversation) {}
    }
}
