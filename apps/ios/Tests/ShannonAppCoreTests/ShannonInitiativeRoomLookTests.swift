import XCTest
@testable import ShannonAppCore

/// Her messages about the room are never quoted outside the Talk, on new and older servers (A13).
final class ShannonInitiativeRoomLookTests: XCTestCase {
    func testTheServersFlagDecidesAndOlderServersAreJudgedOnTheSafeSide() throws {
        func message(_ extra: String) throws -> ShannonInitiativeMessageDTO {
            try JSONDecoder().decode(ShannonInitiativeMessageDTO.self, from: Data("""
            {"id":"i","threadId":"t","content":"c","expression":"curious","sourceTitle":"s","sourceURL":"",
             "createdAt":"2026-10-05T00:00:00Z","readAt":null\(extra)}
            """.utf8))
        }
        XCTAssertTrue(try message(#","roomLook":true"#).isAboutTheRoom)
        XCTAssertFalse(try message(#","roomLook":false,"kind":"reach_out","reason":"follow_up""#).isAboutTheRoom)
        // Older servers: no flag.
        XCTAssertTrue(try message(#","bodyLookId":"look-1""#).isAboutTheRoom)
        XCTAssertTrue(try message(#","kind":"reach_out","reason":"saw""#).isAboutTheRoom)
        XCTAssertTrue(try message(#","kind":"reach_out","reason":"follow_up""#).isAboutTheRoom)
        XCTAssertFalse(try message(#","kind":"reach_out","reason":"share""#).isAboutTheRoom)
        XCTAssertFalse(try message("").isAboutTheRoom)
    }
}
