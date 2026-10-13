import XCTest
@testable import ShannonAppCore

final class ShannonComposerSendTests: XCTestCase {
    func testTheSendKeyIsOneNewlineAtTheEnd() {
        XCTAssertTrue(ShannonConversationView.isReturnKeySubmit(old: "こんにちは", new: "こんにちは\n"))
        XCTAssertTrue(ShannonConversationView.isReturnKeySubmit(old: "", new: "\n"))
        // A newline typed mid-text, a paste, and IME confirmation stay text.
        XCTAssertFalse(ShannonConversationView.isReturnKeySubmit(old: "ab", new: "a\nb"))
        XCTAssertFalse(ShannonConversationView.isReturnKeySubmit(old: "a", new: "a\nb\n"))
        XCTAssertFalse(ShannonConversationView.isReturnKeySubmit(old: "こんにちh", new: "こんにちは"))
        XCTAssertFalse(ShannonConversationView.isReturnKeySubmit(old: "a\n", new: "a"))
    }

    func testAHeldBackSendSaysWhy() {
        XCTAssertNil(ShannonConversationView.sendBlockReason(hasContent: false, photoIsLoading: true, isSending: true, isLoadingHistory: true))
        XCTAssertNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: false, isSending: false, isLoadingHistory: false))
        XCTAssertNotNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: false, isSending: true, isLoadingHistory: false))
        XCTAssertNotNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: false, isSending: false, isLoadingHistory: true))
        XCTAssertNotNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: true, isSending: false, isLoadingHistory: false))
    }
}
