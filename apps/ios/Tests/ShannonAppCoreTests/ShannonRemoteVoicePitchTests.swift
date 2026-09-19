import Foundation
import Testing
@testable import ShannonAppCore

@Suite("Shannon remote voice brightness")
struct ShannonRemoteVoicePitchTests {
    @Test("new installs request the bright Live voice style without a custom audio device")
    func defaultBrightStyle() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(ShannonRemoteVoicePitchPolicy.headerValue(defaults: defaults) == "enabled")
    }

    @Test("turning brightness off keeps native audio and requests the natural style")
    func disabledStyleStaysNative() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(false, forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey)

        #expect(!ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(ShannonRemoteVoicePitchPolicy.headerValue(defaults: defaults) == "disabled")
    }

}
