import Testing
@testable import ShannonAppCore

@Suite("Voice route change coalescing")
struct ShannonVoiceRouteChangeGateTests {
    @Test("speaker override updates the route without recursively rebuilding audio")
    func speakerOverride() {
        var gate = ShannonVoiceRouteChangeGate()
        gate.seed(signature: "built-in-mic|receiver")
        #expect(gate.inspect(signature: "built-in-mic|speaker", isSpeakerOverride: true) == .publishOnly)
        #expect(gate.inspect(signature: "built-in-mic|speaker", isSpeakerOverride: true) == .unchanged)
        #expect(gate.inspect(signature: "built-in-mic|speaker", isSpeakerOverride: false) == .unchanged)
    }

    @Test("headset arrival and removal rebuild once per actual route")
    func externalDevice() {
        var gate = ShannonVoiceRouteChangeGate()
        gate.seed(signature: "built-in-mic|speaker")
        #expect(gate.inspect(signature: "headset-mic|headset", isSpeakerOverride: false) == .rebuildAudioDevice)
        #expect(gate.inspect(signature: "headset-mic|headset", isSpeakerOverride: false) == .unchanged)
        #expect(gate.inspect(signature: "built-in-mic|speaker", isSpeakerOverride: false) == .rebuildAudioDevice)
    }
}
