import Foundation

public struct ShannonGeminiVoiceEffectProfile: Equatable, Sendable {
    public let pitchCents: Float
    public let robotAmount: Float

    public init(pitchCents: Float, robotAmount: Float) {
        self.pitchCents = pitchCents
        self.robotAmount = robotAmount
    }
}

public enum ShannonGeminiVoiceEffectPolicy {
    /// The production Gemini voice keeps its natural timbre and receives only the
    /// small lift selected in the browser voice lab. Robot processing is disabled.
    public static let productionProfile = ShannonGeminiVoiceEffectProfile(
        pitchCents: 50,
        robotAmount: 0
    )

    public static func profile(defaults: UserDefaults = .standard) -> ShannonGeminiVoiceEffectProfile {
        guard ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults) else {
            return ShannonGeminiVoiceEffectProfile(pitchCents: 0, robotAmount: 0)
        }
        return productionProfile
    }
}
