import XCTest
@testable import ShannonAppCore

final class ShannonSpeechEchoGuardTests: XCTestCase {
    private let reply = "うん、ちゃんと聞こえてるよ。声に合わせて光も動いてる。"

    private func guarded(_ spoken: String..., at time: TimeInterval = 0) -> ShannonSpeechEchoGuard {
        var guardState = ShannonSpeechEchoGuard()
        for text in spoken { guardState.recordSpoken(text, at: time) }
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
        state.recordSpoken(reply, at: 0)
        XCTAssertTrue(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 1))
        state.reset()
        XCTAssertFalse(state.isEcho("うん、ちゃんと聞こえてるよ。", now: 2))
    }

    func testBlankOrSymbolOnlySpeechIsNotRemembered() {
        var state = ShannonSpeechEchoGuard()
        state.recordSpoken("😊…！", at: 0)
        state.recordSpoken("   ", at: 0)
        XCTAssertFalse(state.isEcho("おはようございます", now: 1))
    }

    func testBoundsRememberedSpeechAndKeepsTheNewest() {
        var state = ShannonSpeechEchoGuard()
        state.recordSpoken("最初に話した大切な内容です", at: 0)
        for index in 0..<40 {
            state.recordSpoken(String(repeating: "あいうえおかきくけこ", count: 4) + "\(index)", at: Double(index))
        }
        XCTAssertFalse(state.isEcho("最初に話した大切な内容です", now: 40))
        XCTAssertTrue(state.isEcho(String(repeating: "あいうえおかきくけこ", count: 4) + "39", now: 40))
    }
}
