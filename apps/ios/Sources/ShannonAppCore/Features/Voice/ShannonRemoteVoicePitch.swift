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
    public static let enabledHeaderValue = "enabled"
    public static let disabledHeaderValue = "disabled"
    public static let productionProfile = ShannonRemoteVoicePitchProfile(
        pitchCents: 50,
        outputGainDecibels: 0
    )

    public static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: enabledDefaultsKey) != nil else { return true }
        return defaults.bool(forKey: enabledDefaultsKey)
    }

    public static func headerValue(defaults: UserDefaults = .standard) -> String {
        isEnabled(defaults: defaults) ? enabledHeaderValue : disabledHeaderValue
    }

    public static func profile(
        for stream: ShannonVoiceAudioStream,
        defaults: UserDefaults = .standard
    ) -> ShannonRemoteVoicePitchProfile? {
        guard stream == .remotePlayout, isEnabled(defaults: defaults) else { return nil }
        return productionProfile
    }
}
