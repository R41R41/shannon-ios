import XCTest
@testable import ShannonAppCore

final class ShannonConversationDisplayModeTests: XCTestCase {
    func testSwitchActionDescribesDestinationInsteadOfCurrentMode() {
        // One name for the display where she faces him: 「向き合う」 (owner's decision, 2026-10-05).
        XCTAssertEqual(ShannonConversationDisplayMode.scroll.switchActionTitle, "向き合う")
        XCTAssertEqual(ShannonConversationDisplayMode.dialogue.japaneseName, "向き合う")
        XCTAssertEqual(ShannonConversationDisplayMode.scroll.switchActionSymbolName, "person.crop.rectangle")
        XCTAssertEqual(ShannonConversationDisplayMode.dialogue.switchActionTitle, "履歴")
        XCTAssertEqual(ShannonConversationDisplayMode.dialogue.switchActionSymbolName, "text.bubble")
    }

    func testTheHintsCallTheDisplayByItsOneName() {
        for sentence in [ShannonBodyCopy.showInTalkHint, ShannonBodyCopy.heroHint, ShannonBodyCopy.replyModeExplanation] {
            XCTAssertTrue(sentence.contains("向き合う表示"), sentence)
            XCTAssertFalse(sentence.contains("対話"), sentence)
        }
    }
}
