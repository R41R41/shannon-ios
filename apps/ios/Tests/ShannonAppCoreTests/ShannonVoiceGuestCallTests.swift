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

    @Test("An owner-only call never offers a summary; a one-sided guest period does not either")
    func summaryNeedsAGuestConversation() {
        var call = ShannonVoiceGuestCallState()
        #expect(call.summaryTurns == nil)
        call.beginGuestPeriod()
        #expect(call.summaryTurns == nil)
        call.record(participant: "", shannon: "はじめまして")
        #expect(call.summaryTurns == nil)
        call.record(participant: "こんにちは", shannon: "こんにちは")
        #expect(call.summaryTurns?.count == 3)
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
        #expect(ShannonVoiceGuestModeCopy.lines.joined().contains("保存しません"))
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

    @Test("Saving on yes adds one Shannon note to the call's thread; declining sends nothing")
    func summaryChoice() async throws {
        let client = CallSummaryClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "browsed"
        model.messages = [.init(role: .user, text: "別の会話")]
        let draft = ShannonVoiceCallSummaryDraft(threadID: "call", turns: [
            .init(role: .participant, text: "はじめまして"), .init(role: .shannon, text: "はじめまして、シャノンです。"),
        ])

        // Declining or dismissing is purely local: the prompt state is dropped and no request exists.
        var prompt: ShannonVoiceCallSummaryPromptState? = .asking(draft)
        #expect(prompt?.draft == draft)
        prompt = nil
        #expect(await client.requests.isEmpty)
        #expect(model.messages.map(\.text) == ["別の会話"])
        #expect(model.cachedHistories["call"] == nil)

        try await model.saveVoiceCallSummary(draft)
        #expect(await client.requests == [draft.turns])
        #expect(model.messages.map(\.text) == ["別の会話"])
        let saved = try #require(model.cachedHistories["call"])
        #expect(saved.count == 1)
        #expect(ShannonVoiceCallSummaryNote.isNote(saved[0].text))
        #expect(saved[0].role == "shannon")
    }
}

private actor CallSummaryClient: ShannonAPIClientProtocol {
    private(set) var requests: [[ShannonVoiceCallContextTurnDTO]] = []

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func saveVoiceCallSummary(
        scopeKey: String, threadId: String?, turns: [ShannonVoiceCallContextTurnDTO]
    ) async throws -> ShannonVoiceCallSummaryResponseDTO {
        requests.append(turns)
        return .init(threadId: threadId ?? "new", summary: "【友人も一緒の通話の要約】\n相手: お友達")
    }
}
