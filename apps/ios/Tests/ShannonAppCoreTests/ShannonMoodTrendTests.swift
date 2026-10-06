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

/// Holds every read until the test answers it, in any order.
private final class HeldMoodClient: ShannonYousuServing, @unchecked Sendable {
    private let lock = NSLock()
    private var held: [(hours: Int, answer: CheckedContinuation<ShannonMoodHistoryDTO, Error>)] = []

    var heldCount: Int { lock.withLock { held.count } }

    func answer(_ index: Int, with result: Result<ShannonMoodHistoryDTO, Error>) {
        let continuation = lock.withLock { held[index].answer }
        continuation.resume(with: result)
    }

    func loadOps(scopeKey: String) async throws -> ShannonOpsReading { throw ShannonAPIError.rejected(status: 404) }
    func sendOpsCommand(scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String) async -> ShannonOpsSendOutcome { .unknownDelivery }
    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO { throw ShannonAPIError.rejected(status: 404) }
    func opsReportScope(scopeKey: String) -> String? { nil }
    func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock { held.append((hours, continuation)) }
        }
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

    func testTheSwitchOffersAnHourADayAndAWeek() {
        XCTAssertEqual(ShannonMoodTrend.windows, [1, 24, 168])
        XCTAssertEqual(ShannonMoodTrend.bucket(hours: 1), 60)
        XCTAssertEqual(ShannonMoodTrend.bucket(hours: 24), 5 * 60)
        XCTAssertEqual(ShannonMoodTrend.bucket(hours: 168), 30 * 60)
    }

    private func date(_ iso: String) throws -> Date { try XCTUnwrap(ShannonYousuTime.date(iso)) }

    func testTheHourIsMarkedOnTheQuarterHoursOfTheClock() throws {
        let tokyo = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        // 19:59:42–20:59:42 in Tokyo: 20:00, 20:15, 20:30, 20:45 (not 20:14, 20:29…).
        let marks = ShannonMoodTrend.quarterHours(from: try date("2026-10-06T10:59:42.000Z"), to: try date("2026-10-06T11:59:42.000Z"), timeZone: tokyo)
        XCTAssertEqual(marks, try ["11:00", "11:15", "11:30", "11:45"].map { try date("2026-10-06T\($0):00.000Z") })
        // A zone 45 minutes off the hour still marks its own quarter hours.
        let nepal = try XCTUnwrap(TimeZone(identifier: "Asia/Kathmandu"))
        let local = ShannonMoodTrend.quarterHours(from: try date("2026-10-06T11:00:00.000Z"), to: try date("2026-10-06T11:20:00.000Z"), timeZone: nepal)
        XCTAssertEqual(local, [try date("2026-10-06T11:00:00.000Z"), try date("2026-10-06T11:15:00.000Z")])
    }

    func testBurstsCollapseIntoBucketsKeepingTheLastPointAtTheBucketStart() throws {
        // An hour: 1-minute buckets from 05:00. Three points seconds apart become one step at 05:10.
        let start = try date("2026-10-05T05:00:00.000Z")
        let now = try date("2026-10-05T06:00:00.000Z")
        let points = [
            point("2026-10-05T05:10:05.000Z", 0.1), point("2026-10-05T05:10:20.000Z", 0.5), point("2026-10-05T05:10:40.000Z", 0.2),
            point("2026-10-05T05:30:00.000Z", -0.3),
        ]
        let raw = ShannonMoodTrend.steps(.valence, points: points, windowStart: start, until: now)
        let hour = ShannonMoodTrend.bucketed(raw, windowStart: start, bucket: ShannonMoodTrend.bucket(hours: 1))
        XCTAssertEqual(hour, [
            ShannonMoodStep(start: try date("2026-10-05T05:10:00.000Z"), end: try date("2026-10-05T05:30:00.000Z"), value: 0.2),
            ShannonMoodStep(start: try date("2026-10-05T05:30:00.000Z"), end: now, value: -0.3),
        ])
        // A day: 5-minute buckets from the window's start (not from the hour), so 05:12 and 05:14 share one.
        let dayStart = try date("2026-10-04T06:02:00.000Z")
        let day = ShannonMoodTrend.bucketed(
            ShannonMoodTrend.steps(.valence, points: [point("2026-10-05T05:12:00.000Z", 0.4), point("2026-10-05T05:14:00.000Z", -0.1), point("2026-10-05T05:17:00.000Z", 0.3)], windowStart: dayStart, until: now),
            windowStart: dayStart, bucket: ShannonMoodTrend.bucket(hours: 24)
        )
        XCTAssertEqual(day.map(\.start), [try date("2026-10-05T05:12:00.000Z"), try date("2026-10-05T05:17:00.000Z")])
        XCTAssertEqual(day.map(\.value), [-0.1, 0.3])
        XCTAssertEqual(day.last?.end, now)
        // A week: 30-minute buckets; a point at 05:59 lands at 05:30 and holds until now.
        let weekStart = try date("2026-09-28T06:00:00.000Z")
        let week = ShannonMoodTrend.bucketed(
            ShannonMoodTrend.steps(.valence, points: [point("2026-10-05T05:31:00.000Z", 0.1), point("2026-10-05T05:59:00.000Z", 0.3)], windowStart: weekStart, until: now),
            windowStart: weekStart, bucket: ShannonMoodTrend.bucket(hours: 168)
        )
        XCTAssertEqual(week, [ShannonMoodStep(start: try date("2026-10-05T05:30:00.000Z"), end: now, value: 0.3)])
        XCTAssertEqual(ShannonMoodTrend.bucketed([], windowStart: start, bucket: 60), [])
    }

    func testTheCarriedInValueStaysAtTheWindowStartWhenBucketed() throws {
        let start = try date("2026-10-05T05:00:00.000Z")
        let now = try date("2026-10-05T06:00:00.000Z")
        let carry = point("2026-10-04T22:00:00.000Z", 0.3)
        let steps = ShannonMoodTrend.steps(.valence, points: [point("2026-10-05T05:20:30.000Z", -0.1)], carryIn: carry, windowStart: start, until: now)
        let drawn = ShannonMoodTrend.bucketed(steps, windowStart: start, bucket: 60)
        XCTAssertEqual(drawn, [
            ShannonMoodStep(start: start, end: try date("2026-10-05T05:20:00.000Z"), value: 0.3),
            ShannonMoodStep(start: try date("2026-10-05T05:20:00.000Z"), end: now, value: -0.1),
        ])
        // Alone, it holds across the whole window.
        let quiet = ShannonMoodTrend.bucketed(ShannonMoodTrend.steps(.valence, points: [], carryIn: carry, windowStart: start, until: now), windowStart: start, bucket: 60)
        XCTAssertEqual(quiet, [ShannonMoodStep(start: start, end: now, value: 0.3)])
        // The words still read the true newest point, not the bucket's.
        let burst = [point("2026-10-05T05:40:01.000Z", 0.5), point("2026-10-05T05:40:30.000Z", -0.3)]
        XCTAssertEqual(ShannonMoodTrend.latestLevels(burst)?[.valence], .low)
    }

    func testTheRowsShareOneSymmetricReach() {
        // Real data moves within about −0.1…0.55: ±0.6.
        XCTAssertEqual(ShannonMoodTrend.yLimit([point("2026-10-05T01:00:00Z", 0.55), point("2026-10-05T02:00:00Z", -0.1)]), 0.6, accuracy: 0.0001)
        // Nothing is drawn tighter than ±0.6.
        XCTAssertEqual(ShannonMoodTrend.yLimit([point("2026-10-05T01:00:00Z", 0.05)]), 0.6, accuracy: 0.0001)
        XCTAssertEqual(ShannonMoodTrend.yLimit([]), 0.6, accuracy: 0.0001)
        // The largest distance of any line, rounded up to 0.1: arousal 0.3 + 0.61 → 0.7; exact tenths stay.
        XCTAssertEqual(ShannonMoodTrend.yLimit([point("2026-10-05T01:00:00Z", 0, 0.91)]), 0.7, accuracy: 0.0001)
        XCTAssertEqual(ShannonMoodTrend.yLimit([point("2026-10-05T01:00:00Z", -0.7)]), 0.7, accuracy: 0.0001)
        // The carried-in value counts; never beyond ±1.
        XCTAssertEqual(ShannonMoodTrend.yLimit([], carryIn: point("2026-10-04T01:00:00Z", -0.84)), 0.9, accuracy: 0.0001)
        XCTAssertEqual(ShannonMoodTrend.yLimit([point("2026-10-05T01:00:00Z", 1, 1, 1)]), 1, accuracy: 0.0001)
    }

    func testThePartBeforeTheRecordIsShownOnlyWithoutACarryIn() throws {
        let start = try date("2026-09-28T06:00:00.000Z")
        let points = [point("2026-10-05T03:00:00Z", 0.2), point("2026-10-05T01:00:00Z", 0.1), point("not a time", 0.9)]
        XCTAssertEqual(ShannonMoodTrend.unrecorded(points, windowStart: start), start..<(try date("2026-10-05T01:00:00Z")))
        // A value from before the window: there is no part before the record.
        XCTAssertNil(ShannonMoodTrend.unrecorded(points, carryIn: point("2026-09-20T00:00:00Z", 0), windowStart: start))
        // A first point at the window's start, or no points at all: nothing to shade.
        XCTAssertNil(ShannonMoodTrend.unrecorded([point("2026-09-28T06:00:00.000Z", 0)], windowStart: start))
        XCTAssertNil(ShannonMoodTrend.unrecorded([], windowStart: start))
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
    private func waitForReads(_ client: HeldMoodClient, _ count: Int) async {
        for _ in 0..<1_000 where client.heldCount < count { await Task.yield() }
        XCTAssertEqual(client.heldCount, count)
    }

    @MainActor
    func testOnlyTheLatestReadIsApplied() async throws {
        let client = HeldMoodClient()
        let model = ShannonMoodTrendModel(client: client)
        let older = ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: "2026-10-05T06:00:00.000Z", hours: 24, points: [point("2026-10-05T01:00:00Z", -0.3)], downsampled: false)
        let newer = ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: "2026-10-05T06:01:00.000Z", hours: 24, points: [point("2026-10-05T01:00:00Z", 0.3)], downsampled: false)
        // Two reads of the same window; the second answers first, then the first answers late.
        let first = Task { await model.reload() }
        await waitForReads(client, 1)
        let second = Task { await model.reload() }
        await waitForReads(client, 2)
        client.answer(1, with: .success(newer))
        await second.value
        client.answer(0, with: .success(older))
        await first.value
        XCTAssertEqual(model.history, newer)
        XCTAssertEqual(model.drawing?.levels?[.valence], .high)
        // A late success never clears 「読めませんでした」 of a newer read.
        let third = Task { await model.reload() }
        await waitForReads(client, 3)
        let fourth = Task { await model.reload() }
        await waitForReads(client, 4)
        client.answer(3, with: .failure(ShannonAPIError.rejected(status: 500)))
        await fourth.value
        client.answer(2, with: .success(older))
        await third.value
        XCTAssertEqual(model.phase, .unreadable)
        XCTAssertEqual(model.history, newer)
    }

    @MainActor
    func testSwitchingQuicklyKeepsTheLastChosenWindow() async {
        let client = HeldMoodClient()
        let model = ShannonMoodTrendModel(client: client)
        // 24→1→24→1: the answers for 24 (any of them) arrive after the last choice and are dropped.
        let toHour = Task { await model.choose(hours: 1) }
        await waitForReads(client, 1)
        let toDay = Task { await model.choose(hours: 24) }
        await waitForReads(client, 2)
        let toHourAgain = Task { await model.choose(hours: 1) }
        await waitForReads(client, 3)
        let hour = ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: "2026-10-05T06:00:00.000Z", hours: 1, points: [point("2026-10-05T05:30:00Z", 0.3)], downsampled: false)
        let firstHour = ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: "2026-10-05T05:59:00.000Z", hours: 1, points: [], downsampled: false)
        let day = ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: "2026-10-05T06:00:00.000Z", hours: 24, points: [point("2026-10-05T01:00:00Z", -0.3)], downsampled: false)
        client.answer(2, with: .success(hour))
        await toHourAgain.value
        client.answer(1, with: .success(day))
        await toDay.value
        client.answer(0, with: .success(firstHour))
        await toHour.value
        XCTAssertEqual(model.hours, 1)
        XCTAssertEqual(model.history, hour)
        XCTAssertEqual(model.phase, .loaded)
    }

    func testTheDrawingIsComputedOncePerAnswer() throws {
        let history = ShannonMoodHistoryDTO(
            schemaVersion: 1, generatedAt: "2026-10-05T06:00:00.000Z", hours: 168,
            points: [point("2026-10-04T06:00:00.000Z", 0.1), point("2026-10-04T06:00:10.000Z", 0.55)], downsampled: false
        )
        let drawing = ShannonMoodTrendDrawing(history: history, hours: 168, readAt: Date())
        XCTAssertEqual(drawing.now, try date("2026-10-05T06:00:00.000Z"))
        XCTAssertEqual(drawing.start, try date("2026-09-28T06:00:00.000Z"))
        XCTAssertEqual(drawing.limit, 0.6, accuracy: 0.0001)
        XCTAssertEqual(drawing.unrecorded, drawing.start..<(try date("2026-10-04T06:00:00.000Z")))
        XCTAssertEqual(drawing.recordStart, try date("2026-10-04T06:00:00.000Z"))
        XCTAssertEqual(drawing.unrecordedShare, 6.0 / 7.0, accuracy: 0.0001)
        // The burst is one step; the words are those of the newest point.
        XCTAssertEqual(drawing.steps[.valence]?.map(\.value), [0.55])
        XCTAssertEqual(drawing.levels?[.valence], .high)
        XCTAssertEqual(drawing.summary, "気分の明るさは明るめ、元気さはふつう、心の開きはふつう")
        let carried = ShannonMoodTrendDrawing(
            history: .init(schemaVersion: 1, generatedAt: "2026-10-05T06:00:00.000Z", hours: 24, points: [], carryIn: point("2026-10-01T00:00:00Z", 0), downsampled: false),
            hours: 24, readAt: Date()
        )
        XCTAssertNil(carried.unrecorded)
        XCTAssertEqual(carried.unrecordedShare, 0)
    }

    @MainActor
    func testALaterFailureKeepsTheLastGoodChart() async {
        let client = FakeMoodClient()
        let model = ShannonMoodTrendModel(client: client)
        let good = ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: nil, hours: 24, points: [point("2026-10-05T01:00:00Z", 0.3)], downsampled: false)
        client.history = .success(good)
        await model.reload()
        client.history = .failure(ShannonAPIError.rejected(status: 500))
        await model.reload()
        XCTAssertEqual(model.phase, .unreadable)
        XCTAssertEqual(model.history, good)
        // 403/404 still hide it, and drop what was read.
        client.history = .failure(ShannonAPIError.rejected(status: 404))
        await model.reload()
        XCTAssertEqual(model.phase, .hidden)
        XCTAssertNil(model.history)
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
