import Foundation
import Testing
@testable import ShannonAppCore

@Suite("Shannon remote voice pitch")
struct ShannonRemoteVoicePitchTests {
    @Test("new installs keep custom WebRTC audio processing retired")
    func defaultProfileIsRetired() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(!ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .remotePlayout, defaults: defaults) == nil)
    }

    @Test("microphone input never receives the pitch profile")
    func microphoneRemainsUnprocessed() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .microphoneInput, defaults: defaults) == nil)
    }

    @Test("a persisted legacy opt-in cannot reactivate remote processing")
    func legacyOptInStaysRetired() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(true, forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey)

        #expect(!ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .remotePlayout, defaults: defaults) == nil)
    }

}
