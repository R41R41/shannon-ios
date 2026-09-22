import Foundation

enum ShannonVoiceRouteChangeDecision: Equatable {
    case unchanged
    case publishOnly
    case rebuildAudioDevice
}

/// Route notifications can be emitted by rebuilding Voice Processing I/O itself.
/// Only a changed physical route needs another audio-device rebuild; a speaker
/// override still updates the UI but must not recursively restart the engine.
struct ShannonVoiceRouteChangeGate {
    private var lastSignature: String?

    mutating func seed(signature: String) {
        lastSignature = signature
    }

    mutating func inspect(
        signature: String,
        isSpeakerOverride: Bool
    ) -> ShannonVoiceRouteChangeDecision {
        guard signature != lastSignature else { return .unchanged }
        lastSignature = signature
        return isSpeakerOverride ? .publishOnly : .rebuildAudioDevice
    }
}
