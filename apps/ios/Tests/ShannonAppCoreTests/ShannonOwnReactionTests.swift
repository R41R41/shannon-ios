import XCTest
@testable import ShannonAppCore

/// Her own emoji reactions beside the owner's (rich chat §4, owner request 2026-10-26).
final class ShannonOwnReactionTests: XCTestCase {
    func testChipsCountTheOwnerAndHerOncePerEmoji() {
        let chips = ShannonReactionChip.chips(mine: ["❤️", "😂"], hers: ["😂", "🎂"])
        XCTAssertEqual(chips.map(\.emoji), ["❤️", "😂", "🎂"])
        XCTAssertEqual(chips.map(\.count), [1, 2, 1])
        XCTAssertEqual(chips.map(\.who), ["ライ氏", "ライ氏とシャノン", "シャノン"])
        XCTAssertEqual(ShannonReactionChip.chips(mine: [], hers: []), [])
    }

    func testDecodesHerReactionFromTheChatResponseTheTalkAndAChange() throws {
        let decoder = JSONDecoder()
        let change = try decoder.decode(ShannonMessageReactionDTO.self, from: Data(#"{"messageId":"m1","emojis":["👍"],"shannonEmojis":["🎂"]}"#.utf8))
        XCTAssertEqual(change.shannonEmojis, ["🎂"])
        let older = try decoder.decode(ShannonMessageReactionDTO.self, from: Data(#"{"messageId":"m1","emojis":[]}"#.utf8))
        XCTAssertNil(older.shannonEmojis)
        let stored = try decoder.decode(StoredConversationMessageDTO.self, from: Data(#"""
        {"id":"8a1f7f4e-6a0e-4c52-9d0e-0d2f3f0f2c11","role":"user","content":"ケーキ焼いた","observedAt":"2026-10-26T12:00:00.000Z",
         "shannonReactions":["🎂"]}
        """#.utf8))
        XCTAssertEqual(stored.shannonReactions, ["🎂"])
        let reaction = try decoder.decode(ShannonOwnReactionDTO.self, from: Data(#"{"messageId":"m1","emoji":"🎂"}"#.utf8))
        XCTAssertEqual(reaction, ShannonOwnReactionDTO(messageId: "m1", emoji: "🎂"))
    }

    @MainActor
    func testHerReactionOnHisMessageShowsAtOnceAndIsHiddenWhileOthersMaySee() {
        let model = ShannonReactionsModel(scopeKey: "owner", client: nil)
        let mine = ConversationMessage(role: .user, text: "ケーキ焼いた")
        model.noteShannonReaction(ShannonOwnReactionDTO(messageId: "server-1", emoji: "🎂"), onMessage: mine.id)
        model.noteShannonReaction(ShannonOwnReactionDTO(messageId: "server-1", emoji: "🎂"), onMessage: mine.id)
        XCTAssertEqual(model.shannonEmojis(for: mine), ["🎂"])
        XCTAssertEqual(model.chips(for: mine).map(\.count), [1])
        // Read back from the server, the message carries hers itself.
        let read = ConversationMessage(role: .user, text: "ケーキ焼いた", serverID: "server-2", shannonReactions: ["😂"])
        XCTAssertEqual(model.shannonEmojis(for: read), ["😂"])
        model.setAudience(othersPresent: true)
        XCTAssertEqual(model.chips(for: read), [])
        XCTAssertEqual(model.shannonEmojis(for: mine), [])
    }
}
