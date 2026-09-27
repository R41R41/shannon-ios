import Foundation
import Testing
@testable import ShannonAppCore

@Suite("Shannon remote voice brightness")
struct ShannonRemoteVoicePitchTests {
    @Test("new installs raise only remote playout by 50 cents")
    func defaultBrightStyle() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(ShannonRemoteVoicePitchPolicy.headerValue(defaults: defaults) == "enabled")
        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .remotePlayout, defaults: defaults) ==
            ShannonRemoteVoicePitchProfile(pitchCents: 50, outputGainDecibels: 0))
        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .microphoneInput, defaults: defaults) == nil)
    }

    @Test("turning brightness off keeps the natural remote voice")
    func disabledStyleStaysNative() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(false, forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey)

        #expect(!ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(ShannonRemoteVoicePitchPolicy.headerValue(defaults: defaults) == "disabled")
        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .remotePlayout, defaults: defaults) == nil)
    }

}
