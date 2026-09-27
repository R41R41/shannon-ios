import Foundation
import Testing
@testable import ShannonAppCore

@Suite("Shannon Gemini voice effect")
struct ShannonGeminiVoiceEffectTests {
    @Test("production keeps the current voice with a 50-cent lift and no robot texture")
    func productionProfile() {
        #expect(ShannonGeminiVoiceEffectPolicy.productionProfile ==
            ShannonGeminiVoiceEffectProfile(pitchCents: 50, robotAmount: 0))
    }

    @Test("turning brightness off keeps Gemini playout dry")
    func disabledProfile() throws {
        let suiteName = "ShannonGeminiVoiceEffectTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(false, forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey)

        #expect(ShannonGeminiVoiceEffectPolicy.profile(defaults: defaults) ==
            ShannonGeminiVoiceEffectProfile(pitchCents: 0, robotAmount: 0))
    }
}
