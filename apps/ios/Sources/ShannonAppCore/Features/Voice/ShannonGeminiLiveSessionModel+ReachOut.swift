#if os(iOS)
import Foundation

/// The microphone after Shannon spoke through the earphones on her own (owner decision 2026-10-02).
///
/// The call that listens is the ordinary voice conversation, started on the Talk her message is in. This
/// only watches it for the length of the window (`ShannonAnswerWait`): an utterance of the owner's makes it
/// a conversation that goes on and is stored as any other; without one the caller ends the call, and nothing
/// was stored.
extension ShannonGeminiLiveSessionModel {
    /// The level above which the microphone counts as hearing sound (`audioLevel` is 0…1).
    static let answerSoundLevel: Float = 0.2

    /// What the owner said or typed in this call, heard or already being answered.
    var hasOwnerInput: Bool {
        !pendingTurns.turns.isEmpty || responseTask != nil || !userTranscript.isEmpty || !shannonTranscript.isEmpty
    }

    var answerCallState: ShannonAnswerCallState {
        switch phase {
        case .requestingPermission, .connecting: .starting
        case .idle, .failed: .ended
        case .listening, .thinking, .speaking, .reconnecting: .live
        }
    }

    /// `stillPrivate` is asked throughout the window: the call's own audio route (hands-free instead of stereo, or the
    /// phone's speaker when the earphones have no microphone profile) must still be only the owner's, or the call is given up.
    /// The call must have been started before this is asked: a call that is still idle counts as ended.
    func awaitAnswer(seconds: Int, stillPrivate: @MainActor () -> Bool) async -> ShannonAnswerOutcome {
        await ShannonAnswerWait.run(
            seconds: seconds,
            observe: {
                ShannonAnswerObservation(
                    call: answerCallState, hasOwnerInput: hasOwnerInput,
                    // The recogniser has heard an utterance end and has not delivered its words yet: that counts as sound.
                    hearsSound: audioLevel > Self.answerSoundLevel || phase == .thinking, isPrivate: stillPrivate()
                )
            },
            sleep: { seconds in (try? await Task.sleep(for: .seconds(seconds))) != nil }
        )
    }
}
#endif
