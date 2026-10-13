import XCTest
@testable import ShannonAppCore

/// 目標 and 点検 (Syzygy ADR-0009 E7, `docs/executive-ui-contract.md`): the answers are read leniently, and the words never
/// show a bare number.
final class ShannonExecutiveTests: XCTestCase {
    func testGoalsAreReadLenientlyAndAnUnreadableGoalIsLeftOut() throws {
        let json = """
        {"goals": [
          {"id": "g1", "title": "短い詩集を作る", "status": "active", "progress": 0.6, "completion": {"summary": "5篇そろう"}},
          {"title": "no id"},
          {"id": "g2", "status": "resting", "origin": "seed", "evidenceCount": "three"},
          {"id": "g3"}
        ]}
        """
        let goals = try JSONDecoder().decode(ShannonGoalsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(goals.goals.map(\.id), ["g1", "g3"], "a goal without an id or with a field of another type is left out")
        XCTAssertNil(goals.activeLimit)
        let first = try XCTUnwrap(goals.goals.first)
        XCTAssertTrue(first.canConfirm && first.canRest && first.canDrop)
        XCTAssertEqual(first.completion?.summary, "5篇そろう")
        XCTAssertFalse(goals.goals[1].canConfirm, "a goal without a status offers no control")
    }

    func testAnswersWithoutTheirListsAreEmpty() throws {
        let empty = Data("{}".utf8)
        XCTAssertEqual(try JSONDecoder().decode(ShannonGoalsDTO.self, from: empty).goals, [])
        XCTAssertEqual(try JSONDecoder().decode(ShannonChoicesDTO.self, from: empty).choices, [])
        XCTAssertEqual(try JSONDecoder().decode(ShannonCapabilitiesDTO.self, from: empty).capabilities, [])
        XCTAssertNil(try JSONDecoder().decode(ShannonInspectionDTO.self, from: empty).today)
    }

    func testASeedIsNeverOfferedAControlUnlessTheServerSaysSo() {
        let seed = ShannonGoalsDTO.Goal(id: "s", status: "active", origin: "seed")
        XCTAssertFalse(seed.canConfirm || seed.canRest || seed.canDrop)
        let allowed = ShannonGoalsDTO.Goal(id: "s", status: "active", origin: "seed", ownerCanRest: true)
        XCTAssertTrue(allowed.canRest)
    }

    func testTheWordsOfTheCounts() {
        XCTAssertEqual(ShannonExecutiveText.share(6, of: 10), "60%（6/10）")
        XCTAssertEqual(ShannonExecutiveText.share(nil, of: 10), "—")
        XCTAssertEqual(ShannonExecutiveText.yen(312.4), "312円")
        XCTAssertNil(ShannonExecutiveText.outcomeWord("none"))
        XCTAssertEqual(ShannonExecutiveText.outcomeWord("something-new"), "不明")
        XCTAssertEqual(ShannonExecutiveText.valueLine(nil), "手応え まだなし")
        XCTAssertEqual(ShannonExecutiveText.valueLine(.init(mean: 0.53, sd: 0.11, n: 14)), "手応え +0.53±0.11（14回）・よい")
    }
}
