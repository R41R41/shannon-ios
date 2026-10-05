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
}
