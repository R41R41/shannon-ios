import Foundation
import Testing
@testable import ShannonAppCore

struct ShannonVoiceBackgroundSilenceTests {
    private let start = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func theLimitIsOneMinute() {
        #expect(ShannonVoiceBackgroundSilence.limit == 60)
        #expect(ShannonVoiceBackgroundSilence.checkInterval < ShannonVoiceBackgroundSilence.limit)
    }

    @Test func aCallInTheForegroundNeverEndsBySilence() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.speech(at: start)
        #expect(silence.silence(at: start.addingTimeInterval(3_600)) == nil)
        #expect(!silence.shouldEnd(at: start.addingTimeInterval(3_600)))
    }

    @Test func backgroundSilenceEndsTheCallAtTheLimit() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        #expect(!silence.shouldEnd(at: start.addingTimeInterval(59)))
        #expect(silence.shouldEnd(at: start.addingTimeInterval(60)))
    }

    @Test func aQuietStretchBeforeLeavingTheAppDoesNotCount() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.speech(at: start)
        // Ten quiet minutes in the foreground, then the owner switches apps.
        let left = start.addingTimeInterval(600)
        silence.enteredBackground(at: left)
        #expect(!silence.shouldEnd(at: left))
        #expect(!silence.shouldEnd(at: left.addingTimeInterval(59)))
        #expect(silence.shouldEnd(at: left.addingTimeInterval(60)))
    }

    @Test func speechFromEitherSideRestartsTheCount() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.speech(at: start.addingTimeInterval(40))
        #expect(!silence.shouldEnd(at: start.addingTimeInterval(90)))
        #expect(silence.shouldEnd(at: start.addingTimeInterval(100)))
    }

    @Test func returningToTheAppStopsTheCountAndLeavingAgainStartsItFresh() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        // A second background notification must not move the start.
        silence.enteredBackground(at: start.addingTimeInterval(100))
        #expect(silence.enteredBackgroundAt == start)
        silence.enteredForeground()
        #expect(!silence.isInBackground)
        #expect(!silence.shouldEnd(at: start.addingTimeInterval(10_000)))
        let leftAgain = start.addingTimeInterval(10_000)
        silence.enteredBackground(at: leftAgain)
        #expect(!silence.shouldEnd(at: leftAgain.addingTimeInterval(30)))
    }

    @Test func aReplyBeingMadeOrSpokenIsNeverSilenceHoweverLongItTakes() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.speech(at: start.addingTimeInterval(10))
        // He asked something; she looks something up for 90 seconds and then speaks for two minutes.
        for second in stride(from: 15.0, through: 220, by: 15) {
            let ends = silence.shouldEnd(at: start.addingTimeInterval(second), replyInProgress: true)
            #expect(!ends)
        }
        // Her reply was last seen in progress at 210 s: the minute counts from there, not from his last words.
        let soonAfter = silence.shouldEnd(at: start.addingTimeInterval(225), replyInProgress: false)
        let justBefore = silence.shouldEnd(at: start.addingTimeInterval(269), replyInProgress: false)
        let atTheLimit = silence.shouldEnd(at: start.addingTimeInterval(270), replyInProgress: false)
        #expect(!soonAfter)
        #expect(!justBefore)
        #expect(atTheLimit)
    }

    @Test func aReplyInProgressDoesNotMatterInTheForeground() {
        var silence = ShannonVoiceBackgroundSilence()
        let ends = silence.shouldEnd(at: start.addingTimeInterval(3_600), replyInProgress: true)
        #expect(!ends)
        #expect(silence.lastSpeechAt == nil)
    }

    @Test func theSnackbarSaysOneMinute() {
        #expect(ShannonVoiceBackgroundCopy.endedAfterSilence == "1分間お話がなかったので、音声会話を終了しました。会話は保存されています。")
    }

    @Test func timeSpentSuspendedCounts() {
        // An interruption suspends the app; when it runs again the wall clock has moved on.
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.speech(at: start.addingTimeInterval(30))
        #expect(silence.shouldEnd(at: start.addingTimeInterval(30 + 1_800)))
    }
}
