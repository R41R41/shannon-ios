import XCTest
@testable import ShannonAppCore

final class ShannonConversationDisplayModeTests: XCTestCase {
    func testSwitchActionDescribesDestinationInsteadOfCurrentMode() {
        XCTAssertEqual(ShannonConversationDisplayMode.scroll.switchActionTitle, "対話")
        XCTAssertEqual(ShannonConversationDisplayMode.scroll.switchActionSymbolName, "person.crop.rectangle")
        XCTAssertEqual(ShannonConversationDisplayMode.dialogue.switchActionTitle, "履歴")
        XCTAssertEqual(ShannonConversationDisplayMode.dialogue.switchActionSymbolName, "text.bubble")
    }
}
