import Foundation
import Testing
@testable import ShannonAppCore

struct ShannonVoiceBargeInRuleTests {
    private func speaking(at time: TimeInterval = 10) -> ShannonVoiceBargeInRule {
        var rule = ShannonVoiceBargeInRule()
        rule.voiceSounding(at: time)
        return rule
    }

    @Test func aShortUtteranceWhileSheSpeaksDoesNotStopHer() {
        var rule = speaking()
        rule.speechStarted(at: 10.5)
        let admitted1 = rule.admits("うん", now: 11)
        #expect(!admitted1)
        rule.speechStarted(at: 12)
        let backchannel = rule.admits("へえ、そうなんだ", now: 12.5) // 7 characters once normalized
        #expect(!backchannel)
    }

    @Test func aStopWordAlwaysStopsHer() {
        for word in ["止めて", "とめて", "待って", "ちょっと待って", "ストップ", "STOP", "やめて", "静かに", "黙って", "まって！"] {
            var rule = speaking()
            rule.speechStarted(at: 10.5)
            let admitted2 = rule.admits(word, now: 11)
            #expect(admitted2, "\(word)")
        }
        #expect(ShannonVoiceBargeInRule.isStopWord(ShannonSpeechEchoGuard.normalized("ストップストップ")))
        #expect(!ShannonVoiceBargeInRule.isStopWord(ShannonSpeechEchoGuard.normalized("はい")))
    }

    @Test func eightCharactersOrMoreKeepTheEchoRule() {
        var rule = speaking()
        rule.speechStarted(at: 10.5)
        let admitted3 = rule.admits("ちょっと別の話をしていい？", now: 11)
        #expect(admitted3)
        rule.speechStarted(at: 12)
        let eight = rule.admits("あいうえおかきく", now: 12.5) // exactly 8
        #expect(eight)
    }

    @Test func theShortRuleCoversThreeTenthsOfASecondAfterHerVoice() {
        var rule = speaking()
        rule.voiceStopped(at: 20)
        rule.speechStarted(at: 20.25)
        let admitted4 = rule.admits("うん", now: 21)
        #expect(!admitted4)
        // Speech that began after the tail is an answer and goes through.
        rule.speechStarted(at: 20.4)
        let admitted5 = rule.admits("うん", now: 21)
        #expect(admitted5)
    }

    @Test func aShortAnswerAfterSheFinishedGoesThrough() {
        var rule = speaking()
        rule.voiceStopped(at: 30)
        rule.speechStarted(at: 31)
        let admitted6 = rule.admits("はい", now: 31.5)
        #expect(admitted6)
        // Never having spoken, nothing is near her voice.
        var fresh = ShannonVoiceBargeInRule()
        fresh.speechStarted(at: 1)
        let admitted7 = fresh.admits("はい", now: 1.5)
        #expect(admitted7)
    }

    @Test func aTranscriptArrivingWhileSheSpeaksIsNearHerVoiceWhateverItsStart() {
        var rule = ShannonVoiceBargeInRule()
        rule.speechStarted(at: 1)
        rule.voiceSounding(at: 1.2)
        let admitted8 = rule.admits("あ", now: 1.5)
        #expect(!admitted8)
        // The origin is forgotten with each transcript.
        rule.voiceStopped(at: 2)
        let admitted9 = rule.admits("あ", now: 5)
        #expect(admitted9)
    }

    @Test func stoppingWithoutHavingSoundedLeavesNoTail() {
        var rule = ShannonVoiceBargeInRule()
        rule.voiceStopped(at: 5)
        #expect(!rule.isNearVoice(at: 5.1))
        rule.voiceSounding(at: 6)
        rule.reset()
        #expect(!rule.isNearVoice(at: 6))
    }
}
