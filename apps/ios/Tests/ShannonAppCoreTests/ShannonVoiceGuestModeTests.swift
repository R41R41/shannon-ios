import Testing
@testable import ShannonAppCore

@Suite("Temporary guest voice mode")
struct ShannonVoiceGuestModeTests {
    @Test("Owner and guest modes expose different persistence boundaries")
    func persistenceBoundary() {
        #expect(ShannonVoiceParticipantMode.owner.allowsTranscriptPersistence)
        #expect(ShannonVoiceParticipantMode.owner.allowsCameraSharing)
        #expect(!ShannonVoiceParticipantMode.guest.allowsTranscriptPersistence)
        #expect(!ShannonVoiceParticipantMode.guest.allowsCameraSharing)
    }

    @Test("Guest captions avoid claiming a single identified speaker")
    func transcriptLabels() {
        #expect(ShannonVoiceParticipantMode.owner.transcriptSpeakerName == "あなた")
        #expect(ShannonVoiceParticipantMode.guest.transcriptSpeakerName == "参加者")
    }
}
