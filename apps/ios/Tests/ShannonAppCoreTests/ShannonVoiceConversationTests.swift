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
}
