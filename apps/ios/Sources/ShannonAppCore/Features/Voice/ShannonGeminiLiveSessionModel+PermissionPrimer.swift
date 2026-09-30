#if os(iOS)
import Foundation

/// Pre-permission explanation that runs immediately before the system microphone request.
/// The system prompt still appears only as a direct result of the user's tap.
extension ShannonGeminiLiveSessionModel {
    /// Returns `true` when the session may ask the system for microphone access now.
    func passMicrophonePrimer(generation: UUID) async -> Bool {
        switch microphonePermission() {
        case .granted:
            return true
        case .denied:
            microphonePrimerPhase = .denied
            fail("設定でマイクを許可すると、音声で話せます。", recovery: .openSettings)
            return false
        case .undetermined:
            microphonePrimerPhase = .explain
            let proceed = await withCheckedContinuation { continuation in
                microphonePrimerContinuation = continuation
            }
            guard proceed, sessionGenerationID == generation else { return false }
            microphonePrimerPhase = .requesting
            return true
        }
    }

    /// The user tapped the primer's continue button.
    public func confirmMicrophonePrimer() {
        guard microphonePrimerPhase == .explain else { return }
        resolveMicrophonePrimer(proceed: true)
    }

    /// Closes a denied-state primer while leaving the failed call's recovery visible.
    public func dismissMicrophonePrimer() {
        guard microphonePrimerPhase == .denied else { return }
        microphonePrimerPhase = nil
    }

    func resolveMicrophonePrimer(proceed: Bool) {
        guard let continuation = microphonePrimerContinuation else { return }
        microphonePrimerContinuation = nil
        continuation.resume(returning: proceed)
    }
}
#endif
