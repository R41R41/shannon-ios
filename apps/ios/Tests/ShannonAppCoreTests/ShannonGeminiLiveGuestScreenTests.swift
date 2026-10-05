import SwiftUI
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
        // After the moments in which what arrives is still his (`recogniserLag`).
        try? await Task.sleep(for: .seconds(ShannonGeminiLiveSessionModel.recogniserLag + 0.1))
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
        // What the assembler held is finished at the tap, as his: a guest's first words are never merged into it.
        XCTAssertEqual(model.pendingTurns.turns.map(\.rawText), ["明日の予定は"])
        XCTAssertEqual(model.userTranscript, "")
        // First words that arrive within the recogniser's lag were spoken before the tap: still his, shown nowhere.
        model.handle(.inputTranscript("歯医者だっけ。"))
        XCTAssertEqual(model.userTranscript, "", "the preview does not show it")
        await waitForFinalization(model, turns: 2)
        XCTAssertEqual(model.pendingTurns.turns.count, 2, "answered in the call")
        XCTAssertEqual(model.pendingTurns.displayText, "", "and never shown")

        // Once the lag has passed, the guests' words are theirs.
        try? await Task.sleep(for: .seconds(ShannonGeminiLiveSessionModel.recogniserLag + 0.1))
        model.handle(.inputTranscript("はじめまして。"))
        XCTAssertEqual(model.userTranscript, "はじめまして。")
        await waitForFinalization(model, turns: 3)
        XCTAssertEqual(model.pendingTurns.displayText, "はじめまして。")
        XCTAssertEqual(model.pendingTurns.turns.last?.rawText, "はじめまして。", "not merged into his words")
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
        workspace.restoreFailedText("保険証は？")
        model.switchParticipantMode(to: .guest, origin: .spoken)
        XCTAssertEqual(workspace.typedMessage, "")
        workspace.endCall(model)
        XCTAssertEqual(workspace.typedMessage, "保険証は？")
        XCTAssertNil(workspace.ownerMessageAside)
        withExtendedLifetime(conversation) {}
    }

    /// iPhone in front during 「友人も一緒」: her notifications have no banner and no sound, only the list and the badge.
    func testHerNotificationsShowNoBannerOrSoundWhileAFriendIsInTheCall() {
        XCTAssertEqual(ShannonGuestCallNotifications.foregroundPresentation(hidesOwnerScreens: true), [.list, .badge])
        XCTAssertEqual(ShannonGuestCallNotifications.foregroundPresentation(hidesOwnerScreens: false), [.banner, .list, .sound, .badge])
    }

    /// A new call that replaces a failed 「友人も一緒」 call gives the owner's set-aside text back first.
    func testANewCallGivesBackTheTextSetAsideInAFailedFriendsCall() {
        let workspace = ShannonVoiceWorkspaceState()
        let model = ShannonGeminiLiveSessionModel()
        let conversation = ShannonConversationModel.designPreview()
        _ = workspace.beginCall(mode: .owner, speechProvider: .gemini, threadID: nil,
            conversationModel: conversation, geminiVoiceModel: model)
        workspace.connectionRequestID = nil
        model.phase = .listening
        workspace.typedMessage = "明日の歯医者は何時？"
        model.switchParticipantMode(to: .guest, origin: .spoken)
        model.fail("x")
        XCTAssertEqual(workspace.typedMessage, "")
        _ = workspace.beginCall(mode: .owner, speechProvider: .gemini, threadID: nil,
            conversationModel: conversation, geminiVoiceModel: model)
        workspace.connectionRequestID = nil
        XCTAssertEqual(workspace.typedMessage, "明日の歯医者は何時？")
        model.stop()
    }

    /// View level: the cover both apps use (the iPhone's overlay under the pill, the Mac's replacement of Talk) is
    /// drawn exactly while it is on. A red stand-in for the owner's Talk is rendered and its middle pixel read.
    func testTheCoverIsDrawnOverTheOwnersTalkExactlyWhileOn() {
        for style in [ShannonVoiceGuestCoverStyle.overlay, .replace] {
            for spot in [Spot.middle, .corner] {
                XCTAssertTrue(isRed(Color.red.frame(width: 80, height: 80).shannonGuestCover(false, style: style), at: spot))
                XCTAssertFalse(isRed(Color.red.frame(width: 80, height: 80).shannonGuestCover(true, style: style), at: spot),
                               "the owner's Talk is not visible under the cover (\(style), \(spot))")
            }
        }
    }

    private enum Spot { case middle, corner }

    private func isRed(_ view: some View, at spot: Spot) -> Bool {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        guard let image = renderer.cgImage,
              let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return false }
        let (x, y) = spot == .middle ? (image.width / 2, image.height / 2) : (1, image.height - 2)
        let offset = y * image.bytesPerRow + x * (image.bitsPerPixel / 8)
        let info = image.bitmapInfo.rawValue & CGBitmapInfo.alphaInfoMask.rawValue
        let alphaFirst = info == CGImageAlphaInfo.premultipliedFirst.rawValue || info == CGImageAlphaInfo.first.rawValue
            || info == CGImageAlphaInfo.noneSkipFirst.rawValue
        let littleEndian = image.bitmapInfo.contains(.byteOrder32Little)
        // Read red and green whatever the byte order: red is high and green is low only for the stand-in.
        let channels = (0..<4).map { Int(bytes[offset + $0]) }
        let (red, green): (Int, Int) = switch (alphaFirst, littleEndian) {
        case (true, true): (channels[2], channels[1])   // BGRA
        case (true, false): (channels[1], channels[2])  // ARGB
        case (false, true): (channels[3], channels[2])  // ABGR
        case (false, false): (channels[0], channels[1]) // RGBA
        }
        return red > 200 && green < 80
    }

    /// A transcript from speech that began before the tap is his, however late it arrives (here 1.2 s, more than the
    /// fallback window): the decision follows the onset the recogniser reported.
    func testALateTranscriptOfSpeechThatBeganBeforeTheTapIsHis() async {
        let model = liveModel()
        model.handle(.speechStarted())
        model.handle(.speechStopped())
        model.switchParticipantMode(to: .guest, origin: .control)
        try? await Task.sleep(for: .seconds(1.2))
        model.handle(.inputTranscript("明日の歯医者は何時だっけ。"))
        XCTAssertEqual(model.userTranscript, "", "the preview does not show it")
        await waitForFinalization(model, turns: 1)
        XCTAssertEqual(model.pendingTurns.turns.count, 1, "answered in the call")
        XCTAssertEqual(model.pendingTurns.displayText, "", "never shown")
        model.stop()
    }

    /// A sentence begun before the tap and delivered in chunks stays his until its segment has ended; the guests'
    /// next segment is theirs and is not merged into it.
    func testAPreTapSentenceDeliveredInChunksStaysHis() async {
        let model = liveModel()
        model.handle(.speechStarted())
        model.switchParticipantMode(to: .guest, origin: .control)
        try? await Task.sleep(for: .seconds(ShannonGeminiLiveSessionModel.recogniserLag + 0.1))
        model.handle(.inputTranscript("明日の予定は、"))
        model.handle(.inputTranscript("歯医者だっけ。"))
        XCTAssertEqual(model.userTranscript, "")
        model.handle(.speechStopped())
        model.handle(.speechStarted())
        model.handle(.speechStopped())
        model.handle(.inputTranscript("はじめまして。"))
        XCTAssertEqual(model.userTranscript, "はじめまして。", "the guests' words, and only theirs")
        await waitForFinalization(model, turns: 2)
        XCTAssertEqual(model.pendingTurns.turns.map(\.rawText), ["明日の予定は、歯医者だっけ。", "はじめまして。"])
        XCTAssertEqual(model.pendingTurns.displayText, "はじめまして。")
        model.stop()
    }

    func testSpeechSegmentsFollowOnsetsAndForgetSegmentsThatNeverBroughtWords() {
        var segments = ShannonVoiceSpeechSegments()
        XCTAssertEqual(segments.claimTranscript(itemID: nil, at: 0), .unknown, "no onsets reported: the arrival window decides")
        segments.started(itemID: nil, at: 0)
        segments.switchedToGuest()
        XCTAssertEqual(segments.claimTranscript(itemID: nil, at: 1), .owners, "a chunk of the open pre-tap segment")
        XCTAssertEqual(segments.claimTranscript(itemID: nil, at: 2), .owners, "another chunk")
        segments.stopped(itemID: nil, at: 3)
        segments.started(itemID: nil, at: 4)
        segments.stopped(itemID: nil, at: 5)
        XCTAssertEqual(segments.claimTranscript(itemID: nil, at: 6), .others, "the guests' segment, after it")
        XCTAssertTrue(segments.usedOrderFallback, "matched by order: logged")
        // A segment of the guests that never brings words is forgotten after a while.
        segments.started(itemID: nil, at: 10)
        segments.stopped(itemID: nil, at: 10.5)
        segments.started(itemID: nil, at: 30)
        segments.stopped(itemID: nil, at: 31)
        XCTAssertEqual(segments.claimTranscript(itemID: nil, at: 32), .others)
    }

    /// Completions of different turns can arrive out of order: the friend's short 「はじめまして」 overtakes the
    /// owner's long sentence. Matched by item id, his stays his and hers stays hers.
    func testTranscriptsThatArriveOutOfOrderAreMatchedByTheirItem() async {
        let model = liveModel()
        model.handle(.speechStarted(itemID: "owner-a"))
        model.handle(.speechStopped(itemID: "owner-a"))
        model.switchParticipantMode(to: .guest, origin: .control)
        try? await Task.sleep(for: .seconds(ShannonGeminiLiveSessionModel.recogniserLag + 0.1))
        model.handle(.speechStarted(itemID: "guest-b"))
        model.handle(.speechStopped(itemID: "guest-b"))
        model.handle(.inputTranscript("はじめまして。", itemID: "guest-b"))
        XCTAssertEqual(model.userTranscript, "はじめまして。")
        model.handle(.inputTranscript("明日の歯医者は何時だったか、確認しておいてくれる？", itemID: "owner-a"))
        XCTAssertEqual(model.userTranscript, "はじめまして。", "his sentence is not shown")
        await waitForFinalization(model, turns: 2)
        XCTAssertEqual(model.pendingTurns.displayText, "はじめまして。")
        let hidden = model.pendingTurns.turns.filter { model.pendingTurns.hiddenIDs.contains($0.id) }.map(\.rawText)
        XCTAssertEqual(hidden, ["明日の歯医者は何時だったか、確認しておいてくれる？"], "his, answered but hidden")
        model.stop()
    }

    /// Her own voice comes back as a transcript before the owner's pre-tap sentence: it is dropped as echo and takes
    /// its own segment, never his.
    func testAnEchoThatOvertakesTakesItsOwnSegment() async {
        let model = liveModel()
        model.handle(.speechStarted(itemID: "owner-a"))
        model.handle(.speechStopped(itemID: "owner-a"))
        model.switchParticipantMode(to: .guest, origin: .control)
        let line = "こちらこそ、よろしくお願いします。"
        let now = ProcessInfo.processInfo.systemUptime
        model.echoGuard.recordPlayed(line, at: now)
        model.echoWindow.playbackEnded(at: now)
        model.handle(.speechStarted(itemID: "echo"))
        model.handle(.speechStopped(itemID: "echo"))
        model.handle(.inputTranscript(line, itemID: "echo"))
        XCTAssertTrue(model.pendingTurns.turns.isEmpty, "her echo is dropped")
        model.handle(.inputTranscript("明日の予定を教えて。", itemID: "owner-a"))
        XCTAssertEqual(model.userTranscript, "")
        await waitForFinalization(model, turns: 1)
        XCTAssertEqual(model.pendingTurns.displayText, "", "his words stay his")
        model.stop()
    }

    /// After the call returns to 本人だけ, a late transcript of speech heard in 「友人も一緒」 is never answered.
    func testALateTranscriptFromTheEndedFriendsPeriodIsIgnored() async {
        let model = liveModel()
        model.switchParticipantMode(to: .guest, origin: .spoken)
        model.handle(.speechStarted(itemID: "guest-g"))
        model.handle(.speechStopped(itemID: "guest-g"))
        model.switchParticipantMode(to: .owner)
        model.handle(.inputTranscript("ミキの個人的な話", itemID: "guest-g"))
        XCTAssertEqual(model.userTranscript, "")
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(model.pendingTurns.turns.isEmpty)
        model.stop()
    }

    /// The owner's segments are never forgotten (by age or by the count kept) before their transcript arrives.
    func testTheOwnersSegmentWaitsForItsTranscriptHoweverLongAndHoweverManyFollow() {
        var segments = ShannonVoiceSpeechSegments()
        segments.started(itemID: "owner-a", at: 0)
        segments.stopped(itemID: "owner-a", at: 1)
        segments.switchedToGuest()
        for index in 0..<(ShannonVoiceSpeechSegments.retained + 4) {
            segments.started(itemID: "guest-\(index)", at: Double(2 + index))
            segments.stopped(itemID: "guest-\(index)", at: Double(2 + index) + 0.5)
        }
        XCTAssertEqual(segments.claimTranscript(itemID: "owner-a", at: 40), .owners, "39 s late and after 12 others")
        // With nothing known about a transcript, the arrival window decides, never 「the guests'」 by default.
        XCTAssertEqual(segments.claimTranscript(itemID: "never-seen", at: 41), .unknown)
        var empty = ShannonVoiceSpeechSegments()
        empty.started(itemID: nil, at: 0)
        empty.stopped(itemID: nil, at: 0.5)
        _ = empty.claimTranscript(itemID: nil, at: 1)
        XCTAssertEqual(empty.claimTranscript(itemID: nil, at: 2), .unknown, "no segment left: not the guests' by default")
    }

    /// A transcript nothing is known about, just after the switch: the arrival window makes it his.
    func testATranscriptWithAnUnknownItemJustAfterTheSwitchIsHis() async {
        let model = liveModel()
        model.handle(.speechStarted(itemID: "seen"))
        model.switchParticipantMode(to: .guest, origin: .control)
        model.handle(.inputTranscript("ちょっと待って。", itemID: "not-seen"))
        XCTAssertEqual(model.userTranscript, "")
        await waitForFinalization(model, turns: 1)
        XCTAssertEqual(model.pendingTurns.displayText, "")
        model.stop()
    }
}
