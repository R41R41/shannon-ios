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

    @Test func aSentenceHeIsInTheMiddleOfIsNotCutOff() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.speech(at: start)
        // He thinks for 45 seconds, then speaks for 30 without a pause; his words arrive only afterwards.
        silence.ownerSpeechStarted(at: start.addingTimeInterval(45))
        let midSentence = silence.shouldEnd(at: start.addingTimeInterval(70), replyInProgress: false)
        #expect(!midSentence)
        silence.ownerSpeechStopped(at: start.addingTimeInterval(75))
        let recognising = silence.shouldEnd(at: start.addingTimeInterval(78), replyInProgress: false)
        #expect(!recognising)
        silence.ownerSpoke(at: start.addingTimeInterval(79))
        let afterWords = silence.shouldEnd(at: start.addingTimeInterval(130), replyInProgress: false)
        let aMinuteLater = silence.shouldEnd(at: start.addingTimeInterval(139), replyInProgress: false)
        #expect(!afterWords)
        #expect(aMinuteLater)
    }

    @Test func noiseTakenForSpeechHoldsTheCallOnlyForABoundedTime() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        // The recogniser hears something begin and end, and no words ever come.
        silence.ownerSpeechStarted(at: start.addingTimeInterval(50))
        silence.ownerSpeechStopped(at: start.addingTimeInterval(55))
        let waitingForWords = silence.shouldEnd(at: start.addingTimeInterval(80), replyInProgress: false)
        #expect(!waitingForWords)
        // It was not speech: the minute still counts from before it.
        let given = silence.shouldEnd(at: start.addingTimeInterval(85), replyInProgress: false)
        #expect(given)
        // A sound that never ends is not waited for beyond two minutes.
        var endless = ShannonVoiceBackgroundSilence()
        endless.enteredBackground(at: start)
        endless.ownerSpeechStarted(at: start.addingTimeInterval(10))
        let held = endless.shouldEnd(at: start.addingTimeInterval(129), replyInProgress: false)
        let released = endless.shouldEnd(at: start.addingTimeInterval(130), replyInProgress: false)
        #expect(!held)
        #expect(released)
    }

    @Test func wordsThatWereNeverAnsweredDoNotKeepTheCallOpen() {
        // His words arrived, the reply failed and nothing is being made: the minute runs from then.
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.ownerSpoke(at: start.addingTimeInterval(5))
        let generating = silence.shouldEnd(at: start.addingTimeInterval(20), replyInProgress: true)
        #expect(!generating)
        let soon = silence.shouldEnd(at: start.addingTimeInterval(79), replyInProgress: false)
        let later = silence.shouldEnd(at: start.addingTimeInterval(80), replyInProgress: false)
        #expect(!soon)
        #expect(later)
    }

    @Test func anInterruptedCallAlsoEndsAfterOneMinute() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.speech(at: start)
        // A phone call holds the audio.
        let during = silence.shouldEnd(at: start.addingTimeInterval(59), replyInProgress: false, interrupted: true)
        #expect(!during)
        let tooLong = silence.shouldEnd(at: start.addingTimeInterval(60), replyInProgress: false, interrupted: true)
        #expect(tooLong)
        #expect(ShannonVoiceBackgroundSilence.interruptedLimit == 60)
        // A reply that is being made or played is still never silence, interrupted or not.
        let replying = silence.shouldEnd(at: start.addingTimeInterval(600), replyInProgress: true, interrupted: true)
        #expect(!replying)
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
