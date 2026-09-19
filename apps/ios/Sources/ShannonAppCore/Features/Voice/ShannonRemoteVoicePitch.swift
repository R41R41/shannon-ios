import Foundation

public enum ShannonVoiceAudioStream: Sendable {
    case remotePlayout
    case microphoneInput
}

public struct ShannonRemoteVoicePitchProfile: Equatable, Sendable {
    public let pitchCents: Float
    public let outputGainDecibels: Float

    public init(pitchCents: Float, outputGainDecibels: Float) {
        self.pitchCents = pitchCents
        self.outputGainDecibels = outputGainDecibels
    }
}

public enum ShannonRemoteVoicePitchPolicy {
    public static let enabledDefaultsKey = "shannon.voice.remotePitch.enabled"
    public static let productionProfile = ShannonRemoteVoicePitchProfile(
        pitchCents: 200,
        outputGainDecibels: -1
    )

    public static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        // Retired after the custom RTCAudioDevice interrupted microphone capture
        // on physical devices. Keep the key and profile types only so existing
        // preferences remain harmless and older migrations continue to compile.
        false
    }

    public static func profile(
        for stream: ShannonVoiceAudioStream,
        defaults: UserDefaults = .standard
    ) -> ShannonRemoteVoicePitchProfile? {
        nil
    }
}
