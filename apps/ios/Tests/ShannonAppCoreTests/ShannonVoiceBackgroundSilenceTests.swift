import Foundation
import Testing
@testable import ShannonAppCore

struct ShannonVoiceBackgroundSilenceTests {
    private let start = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func theLimitIsFiveMinutes() {
        #expect(ShannonVoiceBackgroundSilence.limit == 300)
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
        #expect(!silence.shouldEnd(at: start.addingTimeInterval(299)))
        #expect(silence.shouldEnd(at: start.addingTimeInterval(300)))
    }

    @Test func aQuietStretchBeforeLeavingTheAppDoesNotCount() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.speech(at: start)
        // Ten quiet minutes in the foreground, then the owner switches apps.
        let left = start.addingTimeInterval(600)
        silence.enteredBackground(at: left)
        #expect(!silence.shouldEnd(at: left))
        #expect(!silence.shouldEnd(at: left.addingTimeInterval(299)))
        #expect(silence.shouldEnd(at: left.addingTimeInterval(300)))
    }

    @Test func speechFromEitherSideRestartsTheCount() {
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.speech(at: start.addingTimeInterval(240))
        #expect(!silence.shouldEnd(at: start.addingTimeInterval(420)))
        #expect(silence.shouldEnd(at: start.addingTimeInterval(540)))
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
        #expect(!silence.shouldEnd(at: leftAgain.addingTimeInterval(60)))
    }

    @Test func timeSpentSuspendedCounts() {
        // An interruption suspends the app; when it runs again the wall clock has moved on.
        var silence = ShannonVoiceBackgroundSilence()
        silence.enteredBackground(at: start)
        silence.speech(at: start.addingTimeInterval(30))
        #expect(silence.shouldEnd(at: start.addingTimeInterval(30 + 1_800)))
    }
}
