import XCTest
@testable import ShannonAppCore

final class ShannonVoiceConversationTests: XCTestCase {
    func testRealtimeTranscriptEventsAreVisibleAsDeltasAndPairInEitherCompletionOrder() throws {
        var state = ShannonRealtimeVoiceTranscriptState()
        let inputDelta = try XCTUnwrap(ShannonRealtimeVoiceEvent.decode(Data(
            #"{"type":"conversation.item.input_audio_transcription.delta","delta":"明日は"}"#.utf8
        )))
        XCTAssertNil(state.apply(inputDelta))
        XCTAssertEqual(state.userText, "明日は")

        XCTAssertNil(state.apply(.inputTranscriptDone("明日は散歩したい")))
        XCTAssertNil(state.apply(.outputTranscriptDelta("朝なら")))
        XCTAssertEqual(state.shannonText, "朝なら")
        XCTAssertEqual(
            state.apply(.outputTranscriptDone("朝なら涼しそう。"))?.user,
            "明日は散歩したい"
        )

        XCTAssertNil(state.apply(.speechStarted))
        XCTAssertEqual(state.userText, "")
        XCTAssertNil(state.apply(.outputTranscriptDone("いいね。")))
        let reversed = state.apply(.inputTranscriptDone("そうしよう"))
        XCTAssertEqual(reversed?.user, "そうしよう")
        XCTAssertEqual(reversed?.shannon, "いいね。")
    }

    func testRealtimeEventsDecodeSpeechResponseAndSafeErrors() {
        XCTAssertEqual(event(#"{"type":"input_audio_buffer.speech_started"}"#), .speechStarted)
        XCTAssertEqual(event(#"{"type":"input_audio_buffer.speech_stopped"}"#), .speechStopped)
        XCTAssertEqual(event(#"{"type":"response.created"}"#), .responseStarted)
        XCTAssertEqual(event(#"{"type":"response.done"}"#), .responseFinished)
        XCTAssertEqual(
            event(#"{"type":"response.output_audio_transcript.delta","delta":"うん"}"#),
            .outputTranscriptDelta("うん")
        )
        XCTAssertEqual(
            event(#"{"type":"error","error":{"code":"session_expired","message":"secret"}}"#),
            .failed("session_expired")
        )
    }

    func testRealtimeOfferDiagnosticsDescribeStructureWithoutKeepingSDP() {
        let sdp = """
        v=0\r
        m=audio 9 UDP/TLS/RTP/SAVPF 111\r
        a=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r
        a=candidate:2 1 UDP 1 192.0.2.2 5001 typ host\r
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
        """

        let diagnostics = ShannonRealtimeOfferDiagnostics(sdp: sdp)

        XCTAssertEqual(diagnostics.audioSectionCount, 1)
        XCTAssertEqual(diagnostics.dataSectionCount, 1)
        XCTAssertEqual(diagnostics.candidateCount, 2)
        XCTAssertEqual(diagnostics.metadata["ice_gathering"], "complete")
        XCTAssertNil(diagnostics.metadata["sdp"])
    }

    func testPrimaryActionFollowsHalfDuplexVoiceState() {
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .idle), .start)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .requestingPermission), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .listening), .send)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .ready), .send)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .transcribing), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .thinking), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .speaking), .stopSpeaking)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .denied), .start)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .failed), .start)
    }

    func testEveryVoicePhaseHasUserFacingLabelAndSymbol() {
        let phases: [ShannonVoicePhase] = [
            .idle, .requestingPermission, .listening, .ready, .transcribing, .thinking, .speaking, .denied, .failed,
        ]
        for phase in phases {
            XCTAssertFalse(phase.japaneseLabel.isEmpty)
            XCTAssertFalse(phase.symbolName.isEmpty)
        }
    }

    func testRecordingPolicyRejectsEmptyShortOversizedAndOverlongAudio() {
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 0.1, byteCount: 1_024))
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 1, byteCount: 0))
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 1, byteCount: 5 * 1_024 * 1_024 + 1))
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 61, byteCount: 1_024))
        XCTAssertTrue(ShannonVoiceRecordingPolicy.isUsable(duration: 1, byteCount: 1_024))
    }

    func testUsageDescriptionRequiresNonEmptyText() {
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent(nil))
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent(42))
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent("  \n"))
        XCTAssertTrue(ShannonVoiceUsageDescriptionPolicy.isPresent("音声認識に使います"))
    }

    func testVoiceDiagnosticsPersistBreadcrumbsWithoutSensitiveContent() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShannonVoiceDiagnosticsTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let diagnostics = ShannonVoiceDiagnostics(
            fileURL: directory.appendingPathComponent("voice.jsonl")
        )

        diagnostics.record(
            "capture.tap.before",
            sessionID: "session-1",
            metadata: [
                "sample_rate": "48000",
                "transcript": "これは保存してはいけない",
                "token_value": "secret-value",
            ]
        )

        let report = diagnostics.report()
        XCTAssertTrue(report.contains("capture.tap.before"))
        XCTAssertTrue(report.contains("sample_rate=48000"))
        XCTAssertTrue(report.contains("transcript=<redacted>"))
        XCTAssertTrue(report.contains("token_value=<redacted>"))
        XCTAssertFalse(report.contains("これは保存してはいけない"))
        XCTAssertFalse(report.contains("secret-value"))
    }

    private func event(_ json: String) -> ShannonRealtimeVoiceEvent? {
        ShannonRealtimeVoiceEvent.decode(Data(json.utf8))
    }
}
