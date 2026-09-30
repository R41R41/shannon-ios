import XCTest
@testable import ShannonAppCore

final class ShannonMemoryRecallCueTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Case: Decodable { let text: String; let memoryTurn: Bool }
        let cases: [Case]
    }

    func testMatchesTheSharedServerFixture() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("config/memory-recall-cues.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        XCTAssertFalse(fixture.cases.isEmpty)
        for item in fixture.cases {
            XCTAssertEqual(ShannonMemoryRecallCue.matches(item.text), item.memoryTurn, item.text)
        }
    }
}
