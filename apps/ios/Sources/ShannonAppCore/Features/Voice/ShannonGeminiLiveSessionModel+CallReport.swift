import Foundation

/// Ending a call and saying so to the other devices (`ShannonVoiceCallPresence`).
extension ShannonGeminiLiveSessionModel {
    /// Ends the call: capture, playback and the session stop, and its end is reported.
    public func stop() {
        stop(keepingCallReport: false)
    }

    /// The call's end, reported once. A reconnect of the same call (another microphone, an audio failure)
    /// does not come here, so the other devices see one call from its start to its real end.
    func reportCallEnded() {
        callIsReported = false
        callReported?(false)
    }

    /// もう一度つなぐ, and the reconnect of the same call: a new session with what was said kept.
    public func retry() async {
        guard let createSession, let performDelegation, let performStreamingDelegation,
              let streamSpeech, let commitTurn, let handleDelegationResponse else { return }
        await start(
            participantMode: participantMode,
            speechProvider: speechProvider,
            preservePendingInput: true,
            createSession: createSession,
            performDelegation: performDelegation,
            performStreamingDelegation: performStreamingDelegation,
            streamSpeech: streamSpeech,
            commitTurn: commitTurn,
            handleDelegationResponse: handleDelegationResponse
        )
    }
}
