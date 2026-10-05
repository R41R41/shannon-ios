import XCTest
@testable import ShannonAppCore

private final class FakeMoodClient: ShannonYousuServing, @unchecked Sendable {
    var history: Result<ShannonMoodHistoryDTO, Error> = .failure(ShannonAPIError.rejected(status: 404))
    var askedHours: [Int] = []

    func loadOps(scopeKey: String) async throws -> ShannonOpsReading { throw ShannonAPIError.rejected(status: 404) }
    func sendOpsCommand(scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String) async -> ShannonOpsSendOutcome { .unknownDelivery }
    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO { throw ShannonAPIError.rejected(status: 404) }
    func opsReportScope(scopeKey: String) -> String? { nil }
    func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO {
        askedHours.append(hours)
        return try history.get()
    }
}

final class ShannonMoodTrendTests: XCTestCase {
    /// The server's contract fixture (`docs/mood-history-contract.md`), read where the API tests keep it.
    private func contractFixture() throws -> ShannonMoodHistoryDTO {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appending(path: "services/api/tests/fixtures/mood-history-v1/response.json"))
        return try JSONDecoder().decode(ShannonMoodHistoryDTO.self, from: data)
    }

    private func point(_ at: String, _ valence: Double, _ arousal: Double = 0.3, _ openness: Double = 0.35) -> ShannonMoodHistoryDTO.Point {
        .init(at: at, valence: valence, arousal: arousal, openness: openness, mood: .init(expression: "calm", feeling: nil), present: nil)
    }

    func testTheContractFixtureDecodes() throws {
        let history = try contractFixture()
        XCTAssertEqual(history.schemaVersion, 1)
        XCTAssertEqual(history.hours, 24)
        XCTAssertFalse(history.points.isEmpty)
        XCTAssertEqual(history.points.first?.mood?.expression, "calm")
        XCTAssertNil(history.points.first?.present)
        XCTAssertNotNil(history.points.first(where: { $0.present != nil })?.present?.kind)
        XCTAssertNotNil(ShannonMoodTrend.summary(history.points))
    }

    func testAPointHoldsUntilTheNextOneAndALongGapIsNotCut() throws {
        // Three hours apart (she was dormant): still one step, never split.
        let points = [point("2026-10-05T00:00:00.000Z", 0.1), point("2026-10-05T03:00:00.000Z", -0.3), point("2026-10-05T03:05:00.000Z", 0.4)]
        let now = try XCTUnwrap(ShannonYousuTime.date("2026-10-05T06:00:00.000Z"))
        let steps = ShannonMoodTrend.steps(.valence, points: points, until: now)
        XCTAssertEqual(steps.count, 3)
        XCTAssertEqual(steps[0].end, ShannonYousuTime.date("2026-10-05T03:00:00.000Z"))
        XCTAssertEqual(steps[0].value, 0.1, accuracy: 0.0001)
        XCTAssertEqual(steps[1].start, ShannonYousuTime.date("2026-10-05T03:00:00.000Z"))
        XCTAssertEqual(steps[1].end, ShannonYousuTime.date("2026-10-05T03:05:00.000Z"))
        // The newest value holds until now.
        XCTAssertEqual(steps[2].end, now)
        // Each line is shown as its distance from where it rests.
        let arousal = ShannonMoodTrend.steps(.arousal, points: [point("2026-10-05T00:00:00.000Z", 0, 0.8)], until: now)
        XCTAssertEqual(arousal.first?.value ?? 0, 0.5, accuracy: 0.0001)
    }

    func testTheCarriedInPointHoldsFromTheWindowStartAndTheServerClockEndsTheWindow() throws {
        let history = ShannonMoodHistoryDTO(
            schemaVersion: 1, generatedAt: "2026-10-05T06:00:00.000Z", hours: 1, points: [],
            carryIn: point("2026-10-04T22:00:00.000Z", 0.3), downsampled: false
        )
        XCTAssertTrue(history.hasMood)
        // A device clock that is an hour fast does not move the window.
        let end = ShannonMoodTrend.windowEnd(history, readAt: Date(timeIntervalSince1970: 2_000_000_000))
        XCTAssertEqual(end, ShannonYousuTime.date("2026-10-05T06:00:00.000Z"))
        let start = end.addingTimeInterval(-3600)
        let quiet = ShannonMoodTrend.steps(.valence, points: [], carryIn: history.carryIn, windowStart: start, until: end)
        XCTAssertEqual(quiet, [ShannonMoodStep(start: start, end: end, value: 0.3)])
        // With a point in the window, the carried-in value holds until that point.
        let inside = try XCTUnwrap(ShannonYousuTime.date("2026-10-05T05:30:00.000Z"))
        let steps = ShannonMoodTrend.steps(.valence, points: [point("2026-10-05T05:30:00.000Z", -0.1)], carryIn: history.carryIn, windowStart: start, until: end)
        XCTAssertEqual(steps.map(\.start), [start, inside])
        XCTAssertEqual(steps.first?.end, inside)
        // Without a generatedAt the time of the read ends the window.
        let undated = ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: nil, hours: 24, points: [], downsampled: nil)
        XCTAssertFalse(undated.hasMood)
        XCTAssertEqual(ShannonMoodTrend.windowEnd(undated, readAt: start), start)
    }

    func testTheCarryInDecodesAndAnOlderAnswerHasNone() throws {
        let json = #"""
        {"schemaVersion":1,"generatedAt":"2026-10-05T07:00:00.000Z","hours":1,"points":[],"downsampled":false,
         "carryIn":{"at":"2026-10-05T05:00:00.000Z","valence":0,"arousal":0.3,"openness":0.35,"mood":{"expression":"calm"},"present":null}}
        """#
        let history = try JSONDecoder().decode(ShannonMoodHistoryDTO.self, from: Data(json.utf8))
        XCTAssertEqual(history.carryIn?.at, "2026-10-05T05:00:00.000Z")
        XCTAssertNil(try contractFixture().carryIn)
    }

    func testUnreadableTimesAreSkippedAndOrderIsRestored() throws {
        let now = try XCTUnwrap(ShannonYousuTime.date("2026-10-05T06:00:00.000Z"))
        let steps = ShannonMoodTrend.steps(.valence, points: [point("2026-10-05T02:00:00Z", 0.2), point("not a time", 0.9), point("2026-10-05T01:00:00Z", -0.2)], until: now)
        XCTAssertEqual(steps.map(\.value), [-0.2, 0.2])
    }

    func testTheSameThreeWordsWithThresholdsAboutPointTwo() {
        XCTAssertEqual(ShannonMoodLevel(deviation: 0.2), .high)
        XCTAssertEqual(ShannonMoodLevel(deviation: 0.19), .normal)
        XCTAssertEqual(ShannonMoodLevel(deviation: -0.19), .normal)
        XCTAssertEqual(ShannonMoodLevel(deviation: -0.2), .low)
        // 明るめ is for 気分の明るさ only; 元気さ and 心の開き are 高め.
        XCTAssertEqual(ShannonMoodLevel.high.word(for: .valence), "明るめ")
        XCTAssertEqual(ShannonMoodLevel.high.word(for: .arousal), "高め")
        XCTAssertEqual(ShannonMoodLevel.high.word(for: .openness), "高め")
        XCTAssertEqual(ShannonMoodLevel.normal.word(for: .arousal), "ふつう")
        XCTAssertEqual(ShannonMoodLevel.low.word(for: .valence), "低め")
        // The newest point: valence +0.3 (明るめ), arousal at rest (ふつう), openness 0.35 - 0.25 (低め).
        let summary = ShannonMoodTrend.summary([
            point("2026-10-05T00:00:00Z", -0.5, 0.9, 0.9),
            point("2026-10-05T01:00:00Z", 0.3, 0.3, 0.1),
        ])
        XCTAssertEqual(summary, "気分の明るさは明るめ、元気さはふつう、心の開きは低め")
        XCTAssertEqual(ShannonMoodTrend.summary([point("2026-10-05T01:00:00Z", 0, 0.6, 0.6)]), "気分の明るさはふつう、元気さは高め、心の開きは高め")
        XCTAssertNil(ShannonMoodTrend.summary([]))
        // A window with no point of its own speaks of the mood carried in.
        XCTAssertEqual(ShannonMoodTrend.summary([], carryIn: point("2026-10-04T20:00:00Z", -0.4)), "気分の明るさは低め、元気さはふつう、心の開きはふつう")
    }

    @MainActor
    func testHiddenUntilAnsweredHiddenOn403And404AndUnreadableOtherwise() async {
        let client = FakeMoodClient()
        let model = ShannonMoodTrendModel(client: client)
        // Nothing is shown before the first answer, so an older server never flashes a spinner.
        XCTAssertEqual(model.phase, .hidden)
        XCTAssertFalse(model.isAvailable)
        for status in [403, 404] {
            client.history = .failure(ShannonAPIError.rejected(status: status))
            await model.reload()
            XCTAssertEqual(model.phase, .hidden, "\(status)")
        }
        client.history = .success(.init(schemaVersion: 1, generatedAt: nil, hours: 24, points: [], downsampled: false))
        await model.reload()
        XCTAssertEqual(model.phase, .loaded)
        // A server error, a rate limit, no connection, or an answer that cannot be read: the section stays, quietly.
        for failure: Error in [ShannonAPIError.rejected(status: 500), ShannonAPIError.rejected(status: 429), URLError(.notConnectedToInternet), DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "x"))] {
            client.history = .failure(failure)
            await model.reload()
            XCTAssertEqual(model.phase, .unreadable)
            XCTAssertTrue(model.isAvailable)
        }
        // The next appearance reads again.
        client.history = .success(.init(schemaVersion: 1, generatedAt: nil, hours: 168, points: [], downsampled: false))
        await model.choose(hours: 168)
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.history?.points, [])
        XCTAssertEqual(client.askedHours, [24, 24, 24, 24, 24, 24, 24, 168])
    }

    @MainActor
    func testTheTrendDoesNotHoldThePage() async {
        // ShannonNowModel.reload reads the page's own parts only; the trend has its own read.
        let client = FakeMoodClient()
        let now = ShannonNowModel(client: client)
        await now.reload()
        XCTAssertTrue(client.askedHours.isEmpty)
        XCTAssertTrue(now.didLoad)
    }
}
