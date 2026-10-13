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

    @MainActor
    func testTextWrittenBackAfterASendIsTheSentText() {
        // An IME commits its marked text into the cleared field: all of it, or only its end.
        XCTAssertTrue(ShannonConversationModel.isDraftWriteBack("元気？", sent: "元気？"))
        XCTAssertTrue(ShannonConversationModel.isDraftWriteBack("天気は？", sent: "明日の東京の天気は？"))
        XCTAssertTrue(ShannonConversationModel.isDraftWriteBack("今の気分は？\n", sent: "今の気分は？"))
        // New typing, and an empty field, are left alone.
        XCTAssertFalse(ShannonConversationModel.isDraftWriteBack("", sent: "元気？"))
        XCTAssertFalse(ShannonConversationModel.isDraftWriteBack("明日", sent: "明日の東京の天気は？"))
        XCTAssertFalse(ShannonConversationModel.isDraftWriteBack("ありがとう", sent: "元気？"))
    }

    func testAHeldBackSendSaysWhy() {
        XCTAssertNil(ShannonConversationView.sendBlockReason(hasContent: false, photoIsLoading: true, isSending: true, isLoadingHistory: true))
        XCTAssertNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: false, isSending: false, isLoadingHistory: false))
        XCTAssertNotNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: false, isSending: true, isLoadingHistory: false))
        XCTAssertNotNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: false, isSending: false, isLoadingHistory: true))
        XCTAssertNotNil(ShannonConversationView.sendBlockReason(hasContent: true, photoIsLoading: true, isSending: false, isLoadingHistory: false))
    }
}
