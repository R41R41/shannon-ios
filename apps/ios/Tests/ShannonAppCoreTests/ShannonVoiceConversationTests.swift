import XCTest
@testable import ShannonAppCore

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
