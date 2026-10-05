import XCTest
@testable import ShannonAppCore

final class ShannonSpeechEchoGuardTests: XCTestCase {
    private let reply = "うん、ちゃんと聞こえてるよ。声に合わせて光も動いてる。"

    private func guarded(_ spoken: String..., at time: TimeInterval = 0) -> ShannonSpeechEchoGuard {
        var guardState = ShannonSpeechEchoGuard()
        for text in spoken { guardState.recordPlayed(text, at: time) }
        return guardState
    }

    func testRecognisesAnExactRepeatOfWhatShannonSaid() {
        XCTAssertTrue(guarded(reply).isEcho("うん、ちゃんと聞こえてるよ。", now: 1))
        XCTAssertTrue(guarded(reply).isEcho("声に合わせて光も動いてる", now: 1))
    }

    func testIgnoresPunctuationWidthCaseAndKanaScript() {
        let state = guarded("シャノン、今日のAetherの進捗を教えて！")
        XCTAssertTrue(state.isEcho("しゃのん 今日の aether の進捗を教えて", now: 1))
        XCTAssertTrue(state.isEcho("ＡＥＴＨＥＲの進捗を教えて😊", now: 1))
    }

    func testToleratesRecognitionNoiseInALongRepeat() {
        // One wrong character in a 24-character transcript still leaves almost every pair intact.
        XCTAssertTrue(guarded(reply).isEcho("うんちゃんと聞こえてるよ声に合わせて光も動いてた", now: 1))
    }

    func testDoesNotDiscardAnUnrelatedUtterance() {
        XCTAssertFalse(guarded(reply).isEcho("明日の午後三時にミーティングを入れておいて", now: 1))
        XCTAssertFalse(guarded(reply).isEcho("ありがとう、そろそろ終わりにするね", now: 1))
    }

    func testKeepsAShortReplyThatReusesHerWords() {
        let state = guarded("Voyagerの件はどうする？")
        XCTAssertFalse(state.isEcho("Voyagerの件ですか", now: 1))
        XCTAssertFalse(state.isEcho("Voyagerのビルドは出した", now: 1))
    }

    func testNeverJudgesTranscriptsShorterThanFiveCharacters() {
        let state = guarded("はい、うん、そうだね。")
        XCTAssertFalse(state.isEcho("はい", now: 1))
        XCTAssertFalse(state.isEcho("うん。", now: 1))
        XCTAssertFalse(state.isEcho("そうだ", now: 1))
    }

    func testShortTranscriptsAreEchoOnlyWhenAnExactCopy() {
        let state = guarded("そろそろ休憩しようか")
        XCTAssertTrue(state.isEcho("そろそろ休憩", now: 1))
        XCTAssertFalse(state.isEcho("そろそろ寝よう", now: 1))
    }

    func testForgetsSpeechOlderThanTheMemoryWindow() {
        let state = guarded(reply, at: 0)
        XCTAssertTrue(state.isEcho("うん、ちゃんと聞こえてるよ。", now: ShannonSpeechEchoGuard.memorySeconds))
        XCTAssertFalse(state.isEcho("うん、ちゃんと聞こえてるよ。", now: ShannonSpeechEchoGuard.memorySeconds + 1))
    }

    func testNothingIsEchoBeforeShannonHasSpokenOrAfterReset() {
        var state = ShannonSpeechEchoGuard()
        XCTAssertFalse(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 0))
        state.recordPlayed(reply, at: 0)
        XCTAssertTrue(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 1))
        state.reset()
        XCTAssertFalse(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 2))
    }

    func testBlankOrSymbolOnlySpeechIsNotRemembered() {
        var state = ShannonSpeechEchoGuard()
        state.recordPlayed("😊…！", at: 0)
        state.recordPlayed("   ", at: 0)
        XCTAssertFalse(state.isEcho("おはようございます", now: 1))
    }

    func testBoundsRememberedSpeechAndKeepsTheNewest() {
        var state = ShannonSpeechEchoGuard()
        state.recordPlayed("最初に話した大切な内容です", at: 0)
        // 150 sentences of 42 characters: more than the 6,000 characters remembered.
        for index in 0..<150 {
            state.recordPlayed(String(repeating: "あいうえおかきくけこ", count: 4) + "\(index)", at: Double(index) * 0.5)
        }
        XCTAssertFalse(state.isEcho("最初に話した大切な内容です", now: 75))
        XCTAssertTrue(state.isEcho(String(repeating: "あいうえおかきくけこ", count: 4) + "149", now: 75))
    }

    func testRemembersALongTalkOfSeveralThousandCharacters() {
        var state = ShannonSpeechEchoGuard()
        state.recordPlayed("むかしむかし、海の見える小さな町に灯台守の少女がいました。", at: 0)
        // About four minutes of speech, 4,500 characters, played one sentence every two seconds.
        for index in 0..<100 {
            state.recordPlayed("その夜も波は静かに寄せては返し、町の明かりがひとつずつ消えていきました\(index)。", at: Double(index) * 2.4)
        }
        XCTAssertTrue(state.isEcho("海の見える小さな町に灯台守の少女がいました", now: 250))
    }

    func testMemoryIsCountedFromTheLastMomentHerVoiceWasSounding() {
        var state = ShannonSpeechEchoGuard()
        // The text of the first sentence was played at 0; her voice went on sounding until 80.
        state.recordPlayed(reply, at: 0)
        state.markSounding(at: 80)
        XCTAssertTrue(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 80 + ShannonSpeechEchoGuard.memorySeconds))
        XCTAssertFalse(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 81 + ShannonSpeechEchoGuard.memorySeconds))
        // After a silence longer than the memory, a new sentence starts a new memory.
        state.recordPlayed("新しい話を始めますね。", at: 300)
        XCTAssertFalse(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 301))
        XCTAssertTrue(state.isEcho("新しい話を始めますね", now: 301))
    }

    func testRecognisesHerVoiceInTheFormThatWasSpoken() {
        // The display text says Voyager; the voice said ボイジャー, which is what the recogniser hears.
        let state = guarded("Voyagerのビルドは今朝出しましたよ。😊")
        XCTAssertTrue(state.isEcho("ボイジャーのビルドは今朝出しましたよ", now: 1))
        XCTAssertTrue(state.isEcho("Voyagerのビルドは今朝出しました", now: 1))
        XCTAssertFalse(state.isEcho("ボイジャーのテストはまだ終わってないよ", now: 1))
    }
}
