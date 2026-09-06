import XCTest
@testable import ShannonAppCore
#if canImport(AVFoundation) && canImport(Speech)
import AVFoundation
import Speech
#endif

final class ShannonVoiceConversationTests: XCTestCase {
    func testPrimaryActionFollowsHalfDuplexVoiceState() {
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .idle), .start)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .requestingPermission), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .listening), .send)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .ready), .send)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .thinking), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .speaking), .stopSpeaking)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .denied), .start)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .failed), .start)
    }

    func testEveryVoicePhaseHasUserFacingLabelAndSymbol() {
        let phases: [ShannonVoicePhase] = [
            .idle, .requestingPermission, .listening, .ready, .thinking, .speaking, .denied, .failed,
        ]
        for phase in phases {
            XCTAssertFalse(phase.japaneseLabel.isEmpty)
            XCTAssertFalse(phase.symbolName.isEmpty)
        }
    }

    func testAudioFormatPolicyRejectsFormatsThatCanCrashAudioTapInstallation() {
        XCTAssertFalse(ShannonVoiceAudioFormatPolicy.isUsable(sampleRate: 0, channelCount: 1))
        XCTAssertFalse(ShannonVoiceAudioFormatPolicy.isUsable(sampleRate: 48_000, channelCount: 0))
        XCTAssertFalse(ShannonVoiceAudioFormatPolicy.isUsable(sampleRate: .nan, channelCount: 1))
        XCTAssertTrue(ShannonVoiceAudioFormatPolicy.isUsable(sampleRate: 48_000, channelCount: 1))
    }

    func testLegacySpeechAuthorizationOnlyRequestsWhenUndetermined() {
        XCTAssertEqual(
            ShannonLegacySpeechAuthorizationAction.action(for: .notDetermined),
            .request
        )
        XCTAssertEqual(
            ShannonLegacySpeechAuthorizationAction.action(for: .authorized),
            .proceed
        )
        XCTAssertEqual(
            ShannonLegacySpeechAuthorizationAction.action(for: .denied),
            .deny
        )
        XCTAssertEqual(
            ShannonLegacySpeechAuthorizationAction.action(for: .restricted),
            .deny
        )
    }

    func testUsageDescriptionRequiresNonEmptyText() {
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent(nil))
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent(42))
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent("  \n"))
        XCTAssertTrue(ShannonVoiceUsageDescriptionPolicy.isPresent("音声認識に使います"))
    }

#if canImport(AVFoundation) && canImport(Speech)
    @available(macOS 26.0, *)
    func testAnalyzerInputOwnsAudioIndependentFromSourceBuffer() throws {
        let format = try XCTUnwrap(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ))
        let source = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8))
        source.frameLength = 8
        let sourceChannel = try XCTUnwrap(source.floatChannelData?[0])
        sourceChannel[0] = 0.25

        let factory = ShannonVoiceAnalyzerInputFactory(outputFormat: format)
        let input = try factory.make(from: source)
        sourceChannel[0] = 0.75

        let ownedBuffer = input.buffer
        let ownedChannel = try XCTUnwrap(ownedBuffer.floatChannelData?[0])
        XCTAssertEqual(ownedChannel[0], 0.25, accuracy: 0.001)
    }
#endif

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
}
