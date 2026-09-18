import Foundation
import Testing
@testable import ShannonAppCore

@Suite("Shannon remote voice pitch")
struct ShannonRemoteVoicePitchTests {
    @Test("new installs enable the approved Marin pitch profile")
    func defaultProfile() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(
            ShannonRemoteVoicePitchPolicy.profile(for: .remotePlayout, defaults: defaults)
                == ShannonRemoteVoicePitchProfile(pitchCents: 200, outputGainDecibels: -1)
        )
    }

    @Test("microphone input never receives the pitch profile")
    func microphoneRemainsUnprocessed() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .microphoneInput, defaults: defaults) == nil)
    }

    @Test("the persisted rollback switch disables remote processing")
    func rollbackSwitch() throws {
        let suiteName = "ShannonRemoteVoicePitchTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(false, forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey)

        #expect(!ShannonRemoteVoicePitchPolicy.isEnabled(defaults: defaults))
        #expect(ShannonRemoteVoicePitchPolicy.profile(for: .remotePlayout, defaults: defaults) == nil)
    }

}
