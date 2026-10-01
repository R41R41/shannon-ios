import Foundation
import Testing
@testable import ShannonAppCore

@Suite("友人も一緒: in-call context, spoken switch, addressing, summary")
@MainActor
struct ShannonVoiceGuestCallTests {
    // MARK: In-call context

    @Test("This call's turns are remembered in order and bounded")
    func inCallContextIsBounded() {
        var call = ShannonVoiceGuestCallState()
        call.beginGuestPeriod()
        #expect(call.requestContext(addressedByName: false, followsShannonTurn: false).introductionStart)
        for index in 0..<50 {
            call.record(participant: "話\(index)" + String(repeating: "あ", count: 900), shannon: "返事\(index)")
        }
        let context = call.requestContext(addressedByName: true, followsShannonTurn: false)
        #expect(context.turns.count == ShannonVoiceGuestCallState.requestTurnLimit)
        #expect(context.turns.last == .init(role: .shannon, text: "返事49"))
        #expect(context.turns.allSatisfy { $0.text.count <= ShannonVoiceGuestCallState.turnCharacterLimit })
        #expect(context.addressedByName)
        #expect(!context.introductionStart)
        #expect(call.turns.count == ShannonVoiceGuestCallState.retainedTurnLimit)
    }

    @Test("Speech Shannon stayed quiet for is still context; an empty reply adds nothing")
    func quietTurnsStayInContext() {
        var call = ShannonVoiceGuestCallState()
        call.beginGuestPeriod()
        call.record(participant: "声は外部のものを使ってる", shannon: "")
        call.record(participant: "", shannon: "はじめまして、シャノンです。")
        #expect(call.turns == [
            .init(role: .participant, text: "声は外部のものを使ってる"),
            .init(role: .shannon, text: "はじめまして、シャノンです。"),
        ])
    }

    @Test("A period has its own call id, hands its turns over once, and a new period starts clean")
    func periodLifecycle() {
        var call = ShannonVoiceGuestCallState()
        #expect(call.endGuestPeriod() == nil)
        #expect(call.requestContext(addressedByName: false, followsShannonTurn: false).callId == nil)

        call.beginGuestPeriod(callID: "call-0001")
        #expect(call.requestContext(addressedByName: false, followsShannonTurn: false).callId == "call-0001")
        call.record(participant: "", shannon: "はじめまして")
        // Nobody but Shannon spoke: there is nothing to remember.
        #expect(call.endGuestPeriod()?.isEmpty == true)

        call.beginGuestPeriod(callID: "call-0002")
        call.record(participant: "ミキと言います", shannon: "ミキさん、よろしくお願いします。")
        let period = call.endGuestPeriod()
        #expect(period == ShannonVoiceGuestPeriod(callID: "call-0002", turns: [
            .init(role: .participant, text: "ミキと言います"), .init(role: .shannon, text: "ミキさん、よろしくお願いします。"),
        ]))
        #expect(period?.isEmpty == false)
        #expect(call.turns.isEmpty)
        #expect(call.endGuestPeriod() == nil)
        #expect(call.hadGuestPeriod)

        call.beginGuestPeriod()
        #expect(call.callID != nil && call.callID != "call-0002")
        #expect(call.turns.isEmpty)
    }

    @Test("Someone may be listening from the question until the owner says nobody is there")
    func companionSuspicion() {
        var call = ShannonVoiceGuestCallState()
        #expect(!call.companionSuspected)
        call.askedAboutCompanion(now: 10)
        #expect(call.companionSuspected)
        #expect(ShannonVoiceCompanionCue.denies("いや、一人だよ"))
        #expect(ShannonVoiceCompanionCue.denies("いないよ"))
        #expect(!ShannonVoiceCompanionCue.denies("うん"))
        #expect(!ShannonVoiceCompanionCue.denies("今日の予定を教えて"))
        call.companionDenied()
        #expect(!call.companionSuspected)
        call.askedAboutCompanion(now: 20)
        call.beginGuestPeriod()
        #expect(!call.companionSuspected)

        let marked = ShannonVoiceUserUtteranceDTO(id: "u", text: "予定は？", companionPresent: true)
        let json = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(marked)) as? [String: Any]
        #expect(json?["companionPresent"] as? Bool == true)
        let plain = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ShannonVoiceUserUtteranceDTO(id: "u", text: "予定は？"))) as? [String: Any]
        #expect(plain?["companionPresent"] == nil)
    }

    @Test("The call context is sent only inside the utterance and omitted for owner turns")
    func utteranceEncoding() throws {
        let owner = ShannonVoiceUserUtteranceDTO(id: "u1", text: "今日の予定", source: .speech, rawText: "今日の予定")
        let ownerJSON = try #require(String(data: JSONEncoder().encode(owner), encoding: .utf8))
        #expect(!ownerJSON.contains("callContext"))

        let guest = ShannonVoiceUserUtteranceDTO(
            id: "u2", text: "いつもこうなの", source: .speech, rawText: "いつもこうなの",
            callContext: .init(turns: [.init(role: .participant, text: "声可愛いね")],
                addressedByName: false, followsShannonTurn: true, introductionStart: false))
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(guest)) as? [String: Any])
        let context = try #require(object["callContext"] as? [String: Any])
        #expect(context["followsShannonTurn"] as? Bool == true)
        // A context without a call id stays valid for a server that predates people memory.
        #expect(context["callId"] == nil)
        #expect((context["turns"] as? [[String: String]])?.first == ["role": "participant", "text": "声可愛いね"])
    }

    @Test("Pending turns carry the addressing flags and hide the switch cue from subtitles")
    func pendingTurnFlags() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "", text: ShannonVoiceGuestCallState.introductionCue, source: .typed, isIntroductionCue: true)
        ledger.append(rawText: "シャノン、何ができるの", text: "シャノン、何ができるの", source: .speech,
            addressedByName: true, followsShannonTurn: false)
        let batch = try #require(ledger.batch())
        #expect(batch.rawText == "シャノン、何ができるの")
        #expect(ledger.displayText == "シャノン、何ができるの")
        #expect(batch.addressedByName)
        #expect(!batch.followsShannonTurn)
        #expect(batch.localReply == nil)
    }

    @Test("A reaction right after Shannon's turn counts as following it")
    func followUpWindow() {
        #expect(ShannonVoiceGuestCallState.follows(shannonTurnEndedAt: nil, isSpeaking: true, now: 10))
        #expect(ShannonVoiceGuestCallState.follows(shannonTurnEndedAt: 100, isSpeaking: false, now: 108))
        #expect(!ShannonVoiceGuestCallState.follows(shannonTurnEndedAt: 100, isSpeaking: false, now: 113))
        #expect(!ShannonVoiceGuestCallState.follows(shannonTurnEndedAt: nil, isSpeaking: false, now: 10))
    }

    // MARK: Spoken switch

    @Test("Plain statements that a friend is here switch", arguments: [
        "友達を紹介するね", "シャノン、友達を紹介するね。", "友人を紹介します", "彼女を紹介させて",
        "友達と一緒にいる", "今日は友達も一緒だよ", "友人も一緒にして",
        "シャノン。今、友達とご飯食べてて。ちょっと紹介したい。",
        "友達とカフェにいて、紹介したい",
    ])
    func certainCues(text: String) {
        #expect(ShannonVoiceCompanionCue.detect(in: text) == .switchToGuest)
    }

    @Test("Wording that only suggests someone is present makes Shannon ask", arguments: [
        "今、友達とご飯食べてて", "友達が隣にいるんだけど", "友達に自己紹介して", "友達が来た",
        "友達を紹介したい",
    ])
    func uncertainCues(text: String) {
        #expect(ShannonVoiceCompanionCue.detect(in: text) == .ask)
    }

    @Test("Past, future, hypothetical, negated, reported and third-party wording does nothing", arguments: [
        "昨日友達を紹介された", "友達と一緒にいた", "今度友達を紹介するね", "友達を紹介してほしい",
        "友達を紹介する方法を教えて", "友達は紹介しない", "もし友達が来たらどうする", "友達と一緒に映画に行きたい",
        "友達も一緒に行っていいかな", "友達が寿司好きって言ってた", "明日友達とご飯食べる",
        "今日の予定を教えて", "紹介文を書いて", "さっき友達と一緒だった", "友達も一緒なら楽しいのに",
    ])
    func nonCues(text: String) {
        #expect(ShannonVoiceCompanionCue.detect(in: text) == nil)
    }

    @Test("Only a short plain yes confirms the question")
    func confirmation() {
        for yes in ["うん", "はい。", "そうだよ", "うん、一緒", "お願い", "そう、紹介したい"] {
            #expect(ShannonVoiceCompanionCue.confirms(yes), "\(yes)")
        }
        for no in ["いや", "違うよ", "いないよ", "一人だよ", "うん、でも今は本人だけでいい", "今日の天気は", "", "そうじゃない"] {
            #expect(!ShannonVoiceCompanionCue.confirms(no), "\(no)")
        }
    }

    @Test("The question is answered by the next utterance or not at all")
    func companionQuestionExpires() {
        var call = ShannonVoiceGuestCallState()
        let result1 = call.takeCompanionQuestion(now: 0)
        #expect(!result1)
        call.askedAboutCompanion(now: 100)
        let result2 = call.takeCompanionQuestion(now: 110)
        #expect(result2)
        let result3 = call.takeCompanionQuestion(now: 111)
        #expect(!result3)
        call.askedAboutCompanion(now: 200)
        let result4 = call.takeCompanionQuestion(now: 231)
        #expect(!result4)
    }

    // MARK: Greeting after her line (PP-25)

    @Test("A greeting that begins after Shannon finished is kept; her own echo is still discarded")
    func greetingIsNotEcho() {
        var echo = ShannonSpeechEchoGuard()
        echo.recordSpoken("はじめまして、シャノンです。", at: 0)
        #expect(echo.isEcho("はじめまして", now: 3))

        // The friend answers after playback ended: speech started after her line.
        var window = ShannonVoiceEchoWindow()
        window.playbackEnded(at: 2)
        window.speechStarted(isSpeaking: false, now: 2.9)
        let result5 = window.shouldCompare("はじめまして", isSpeaking: false, now: 3.6)
        #expect(!result5)

        // Her own tail: the speech started while she was still playing, the transcript arrived late.
        window.speechStarted(isSpeaking: true, now: 5)
        window.playbackEnded(at: 5.5)
        let result6 = window.shouldCompare("はじめまして", isSpeaking: false, now: 6)
        #expect(result6)

        // Speaker tail just after the last sample still counts as playback.
        window.playbackEnded(at: 10)
        window.speechStarted(isSpeaking: false, now: 10.1)
        let result7 = window.shouldCompare("こんにちは", isSpeaking: false, now: 10.8)
        #expect(result7)

        // No speech-start event seen: keep the previous, stricter behaviour.
        window.playbackEnded(at: 20)
        let result8 = window.shouldCompare("こんにちは", isSpeaking: false, now: 21)
        #expect(result8)

        // A long transcript is always compared, even when it began after playback.
        window.playbackEnded(at: 30)
        window.speechStarted(isSpeaking: false, now: 31)
        let result9 = window.shouldCompare("はじめまして、シャノンです。今日はいい日ですね", isSpeaking: false, now: 32)
        #expect(result9)

        // During playback everything is compared; after the grace period nothing is.
        window.speechStarted(isSpeaking: false, now: 40)
        let result10 = window.shouldCompare("はじめまして", isSpeaking: true, now: 40)
        #expect(result10)
        window.playbackEnded(at: 50)
        let result11 = window.shouldCompare("はじめまして、シャノンです", isSpeaking: false, now: 56)
        #expect(!result11)
    }

    // MARK: Naming and summary note

    @Test("One name for the mode, and a neutral subtitle label")
    func naming() {
        #expect(ShannonVoiceParticipantMode.guest.japaneseName == "友人も一緒")
        #expect(ShannonVoiceGuestModeCopy.name == "友人も一緒")
        #expect(ShannonVoiceParticipantMode.guest.transcriptSpeakerName != "あなた")
        let lines = ShannonGeminiLiveSubtitles(
            speakerName: ShannonVoiceParticipantMode.guest.transcriptSpeakerName,
            userTranscript: "声、可愛いね", shannonTranscript: "えへへ")
        #expect(lines.user == "話し手：声、可愛いね")
        // Both people at the table can read what is kept and how to take it back.
        let notice = ShannonVoiceGuestModeCopy.lines.joined()
        #expect(notice.contains("お名前と、この通話で話したことをシャノンが覚えます"))
        #expect(notice.contains("声で人を聞き分けることはしません"))
        #expect(notice.contains("録音は残しません"))
        #expect(notice.contains("「今回は残さない」"))
        #expect(!notice.contains("保存しません"))
        #expect(ShannonVoiceGuestModeCopy.switchToGuestMessage.contains("お名前とこの通話で話したことをシャノンが覚えます"))
        #expect(ShannonVoiceGuestModeCopy.switchToOwnerMessage.contains("ここまでの分を覚えます"))
        #expect(!ShannonVoiceGuestModeCopy.switchToGuestMessage.contains("つなぎ直"))
    }

    @Test("The saved note is recognised by its heading and shown without it")
    func summaryNote() {
        let note = "【友人も一緒の通話の要約】\n相手: ミキさん\n話したこと: 声の印象。"
        #expect(ShannonVoiceCallSummaryNote.isNote(note))
        #expect(ShannonVoiceCallSummaryNote.body(of: note) == "相手: ミキさん\n話したこと: 声の印象。")
        #expect(!ShannonVoiceCallSummaryNote.isNote("今日はいい日ですね"))
        #expect(ShannonVoiceCallSummaryNote.body(of: "今日はいい日ですね") == "今日はいい日ですね")
    }

    @Test("The end card says the call was remembered, names who, and offers 今回は残さない")
    func callMemoryCard() {
        let first = ShannonVoiceGuestPeriod(callID: "call-0001", turns: [.init(role: .participant, text: "ミキと言います")])
        let second = ShannonVoiceGuestPeriod(callID: "call-0002", turns: [.init(role: .participant, text: "こんにちは")])
        var card = ShannonVoiceCallMemoryState()
        card.began(first)
        card.began(second)
        #expect(card.phase == .remembering)
        #expect(card.callIDs == ["call-0001", "call-0002"])
        card.finished(first, people: ["ミキ"])
        #expect(card.phase == .remembering)
        card.finished(second, people: ["ミキ"])
        #expect(card.phase == .remembered)
        #expect(card.title == "この通話を覚えました")
        #expect(card.detail.contains("ミキさんのお名前と、話したことを覚えました"))
        #expect(card.detail.contains("頭の中の「人」"))
        #expect(ShannonVoiceCallMemoryState.discardLabel == "今回は残さない")

        var unnamed = ShannonVoiceCallMemoryState()
        unnamed.began(second)
        unnamed.finished(second, people: [])
        #expect(unnamed.detail.contains("お名前は聞いていない"))
        #expect(unnamed.detail.contains("ライ氏と二人の時にだけ使います"))

        var failed = ShannonVoiceCallMemoryState()
        failed.began(first)
        failed.finished(first, people: nil)
        #expect(failed.phase == .rememberFailed)
        #expect(failed.unsaved == [first])
        #expect(failed.detail.contains("このままでは何も残りません"))

        var discarded = card
        discarded.phase = .discarded
        #expect(discarded.title == "今回の通話は残しませんでした")
        #expect(discarded.detail.contains("残っていません"))
    }

    @Test("Ending a period remembers it once; 今回は残さない discards every period of the call")
    func rememberAndDiscard() async throws {
        let client = CallMemoryClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "browsed"
        model.messages = [.init(role: .user, text: "別の会話")]
        let period = ShannonVoiceGuestPeriod(callID: "call-0001", turns: [
            .init(role: .participant, text: "ミキと言います"), .init(role: .shannon, text: "ミキさん、よろしくお願いします。"),
        ])

        let remembered = try await model.rememberVoiceCall(period, threadID: "call-thread")
        #expect(remembered.people.map(\.displayName) == ["ミキ"])
        #expect(await client.remembered == ["call-0001"])
        // Nothing of a 「友人も一緒」 period is added to any thread on the device.
        #expect(model.messages.map(\.text) == ["別の会話"])
        #expect(model.cachedHistories["call-thread"] == nil)

        await #expect(throws: ShannonAPIError.self) {
            try await model.rememberVoiceCall(ShannonVoiceGuestPeriod(callID: "empty", turns: []), threadID: nil)
        }
        try await model.discardVoiceCalls(["call-0001", "call-0002"])
        #expect(await client.discarded == ["call-0001", "call-0002"])
    }
}

private actor CallMemoryClient: ShannonAPIClientProtocol {
    private(set) var remembered: [String] = []
    private(set) var discarded: [String] = []

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func rememberVoiceCall(
        scopeKey: String, callId: String, threadId: String?, turns: [ShannonVoiceCallContextTurnDTO]
    ) async throws -> ShannonRememberedVoiceCallDTO {
        remembered.append(callId)
        return .init(callId: callId, people: [.init(id: "p1", displayName: "ミキ")], summary: "相手: ミキさん")
    }

    func discardVoiceCall(scopeKey: String, callId: String) async throws {
        discarded.append(callId)
    }
}
