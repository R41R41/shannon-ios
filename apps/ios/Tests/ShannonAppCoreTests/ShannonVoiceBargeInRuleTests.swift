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
        #expect(ShannonVoiceBargeInRule.isStopRequest(ShannonSpeechEchoGuard.normalized("ストップストップ")))
        #expect(!ShannonVoiceBargeInRule.isStopRequest(ShannonSpeechEchoGuard.normalized("はい")))
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

    @Test func aStartWhoseTranscriptNeverCameDoesNotDecideALaterAnswer() {
        var rule = speaking()
        // Her echo started speech near her voice, but its transcript was empty and never arrived.
        rule.speechStarted(at: 10.1)
        rule.speechStopped(at: 10.6)
        rule.voiceStopped(at: 11)
        // Ten seconds after she finished, the owner answers briefly.
        rule.speechStarted(at: 21)
        rule.speechStopped(at: 21.4)
        let answer = rule.admits("はい", now: 22)
        #expect(answer)
    }

    @Test func aStaleOriginExpiresEvenWithoutANewStart() {
        var rule = speaking()
        rule.speechStarted(at: 10.1)
        rule.speechStopped(at: 10.5)
        rule.voiceStopped(at: 11)
        // A transcript arriving long after that start is not judged by it.
        let late = rule.admits("うん", now: 20)
        #expect(late)
        // Within the window the origin still counts.
        rule.voiceSounding(at: 30)
        rule.speechStarted(at: 30.2)
        rule.speechStopped(at: 30.6)
        rule.voiceStopped(at: 31)
        let fresh = rule.admits("うん", now: 32)
        #expect(!fresh)
    }

    @Test func theAddedStopWordsStopHer() {
        for word in ["まて", "もういい", "うるさい"] {
            #expect(ShannonVoiceBargeInRule.isStopRequest(ShannonSpeechEchoGuard.normalized(word)), "\(word)")
        }
        #expect(!ShannonVoiceBargeInRule.isStopRequest(ShannonSpeechEchoGuard.normalized("ちょっと")))
    }

    @Test func aStopRequestIsTheWholeUtteranceNotAWordInsideASentence() {
        let stops = ["待って", "ちょっと待って", "ストップ", "もういいよ", "まってまって", "ねえ、やめてよ", "静かにして", "シャノン、止めて"]
        for utterance in stops {
            #expect(ShannonVoiceBargeInRule.isStopRequest(ShannonSpeechEchoGuard.normalized(utterance)), "\(utterance)")
        }
        let narrative = ["始まってしまって", "物語が始まって少女は静かに歩いた", "決まって", "集まって", "待っていました",
                         "まとめて", "静かに歩いた", "黙って聞いていた", "ちょっと待ってそれ違うと思う"]
        for utterance in narrative {
            #expect(!ShannonVoiceBargeInRule.isStopRequest(ShannonSpeechEchoGuard.normalized(utterance)), "\(utterance)")
        }
    }

    @Test func aStopWordInsideAShortFragmentDoesNotStopHer() {
        var rule = speaking()
        rule.speechStarted(at: 10.5)
        let fragment = rule.admits("始まって", now: 11)
        #expect(!fragment)
    }

    @Test func aNearStartFoldedIntoTheSameUtteranceReopensIt() {
        var rule = speaking()
        rule.speechStarted(at: 10.1)
        rule.speechStopped(at: 10.4)
        // The recogniser splits one utterance: it starts again near her voice.
        rule.speechStarted(at: 10.6)
        rule.voiceStopped(at: 11)
        // Long after the first stop, but the utterance never stopped again.
        let folded = rule.admits("うん", now: 25)
        #expect(!folded)
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
