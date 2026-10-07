import XCTest
@testable import ShannonAppCore

/// A reader of 学び whose answers the test sets, and whose pins wait until the test lets them go.
private final class FakeLearningClient: ShannonYousuServing, @unchecked Sendable {
    private let lock = NSLock()
    var values: Result<ShannonValuesDTO, Error> = .failure(ShannonAPIError.rejected(status: 403))
    var skills: Result<ShannonSkillsDTO, Error> = .failure(ShannonAPIError.rejected(status: 403))
    var pinAnswer: Result<ShannonSkillDTO, Error>?
    var changeAnswer: Result<ShannonValuesDTO, Error> = .failure(ShannonAPIError.rejected(status: 409))
    private(set) var rollbackVersions: [String?] = []
    private(set) var resumes = 0
    private(set) var pins: [(String, Bool)] = []
    private var heldPin: CheckedContinuation<Void, Never>?
    /// When set, a list read waits until `releaseSkillsRead()` and then answers what `skills` held when it was asked.
    var holdsSkillsReads = false
    private var heldSkillsRead: CheckedContinuation<Void, Never>?
    /// Every value read after a change answers this, when set.
    var valuesAfterChange: ShannonValuesDTO?

    func releaseSkillsRead() { let held = lock.withLock { () -> CheckedContinuation<Void, Never>? in defer { heldSkillsRead = nil }; return heldSkillsRead }; held?.resume() }
    var skillsReadIsHeld: Bool { lock.withLock { heldSkillsRead != nil } }

    func releasePin() { lock.withLock { heldPin }?.resume(); lock.withLock { heldPin = nil } }
    var pinIsHeld: Bool { lock.withLock { heldPin != nil } }

    func loadOps(scopeKey: String) async throws -> ShannonOpsReading { throw ShannonAPIError.rejected(status: 404) }
    func sendOpsCommand(scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String) async -> ShannonOpsSendOutcome { .unknownDelivery }
    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO { throw ShannonAPIError.rejected(status: 404) }
    func opsReportScope(scopeKey: String) -> String? { nil }

    func loadShannonValues(scopeKey: String) async throws -> ShannonValuesDTO { try values.get() }
    func loadShannonSkills(scopeKey: String) async throws -> ShannonSkillsDTO {
        let answer = skills
        if holdsSkillsReads { await withCheckedContinuation { continuation in lock.withLock { heldSkillsRead = continuation } } }
        return try answer.get()
    }
    func rollbackShannonValues(scopeKey: String, versionID: String?) async throws -> ShannonValuesDTO {
        rollbackVersions.append(versionID)
        if let after = valuesAfterChange { values = .success(after) }
        return try changeAnswer.get()
    }
    func resumeShannonValues(scopeKey: String) async throws -> ShannonValuesDTO {
        resumes += 1
        return try changeAnswer.get()
    }
    func setShannonSkillPinned(scopeKey: String, id: String, pinned: Bool) async throws -> ShannonSkillDTO {
        pins.append((id, pinned))
        await withCheckedContinuation { continuation in lock.withLock { heldPin = continuation } }
        return try XCTUnwrap(pinAnswer).get()
    }
}

final class ShannonLearningTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!

    private func iso(hoursAgo: Double) -> String {
        now.addingTimeInterval(-hoursAgo * 3600).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    private func skill(_ id: String, pinned: Bool = false, status: String = "active") -> ShannonSkillDTO {
        .init(id: id, name: id, description: "説明 \(id)", status: status, version: 1, pinned: pinned, uses: 4, successes: 3)
    }

    private func version(_ id: String, to evidence: Int, madeBy: String = "sleep", hoursAgo: Double, frozen: Bool = false) -> ShannonValuesDTO.Version {
        .init(versionId: id, createdAt: iso(hoursAgo: hoursAgo), madeBy: madeBy, evidenceFrom: 1, evidenceTo: evidence, state: "active", frozen: frozen)
    }

    // MARK: The server's answers

    func testTheValuesViewDecodesAsTheRouteWritesIt() throws {
        // `valuesView` in services/api/src/infra/http/learningRoutes.ts: the cell's every field, `sd`, the calibration and the
        // choices by status are there too; the app reads what it shows.
        let json = """
        {"active":{"versionId":"a","createdAt":"2026-10-07T03:00:00.000Z","madeBy":"sleep","formula":"r1","weights":{"world":0.33},
          "baseVersion":null,"evidenceFrom":1,"evidenceTo":12,"state":"active","frozen":false},
         "frozen":false,
         "versions":[{"versionId":"a","createdAt":"2026-10-07T03:00:00.000Z","madeBy":"sleep","formula":"r1","weights":{},"baseVersion":null,
          "evidenceFrom":1,"evidenceTo":12,"state":"active","frozen":false}],
         "cells":[{"level":"choice","choice":"show","context":"","n":8,"mean":0.53,"uncertainty":0.01,"noise":0.1,"volatility":0.01,
          "lastAt":"2026-10-07T02:00:00.000Z","world":0.2,"serve":0.9,"growth":0.5,"costYen":3,"sd":0.1},
          {"level":"root","choice":"","context":"","n":0,"mean":0,"uncertainty":0.33,"noise":0.33,"volatility":0.01,"lastAt":null,
          "world":0,"serve":0,"growth":0,"costYen":0,"sd":0.57}],
         "calibration":{"domains":[],"overall":{"n":0,"brier":null,"skill":null}},"choices":{"settled":4}}
        """
        let values = try JSONDecoder().decode(ShannonValuesDTO.self, from: Data(json.utf8))
        XCTAssertEqual(values.active?.evidenceTo, 12)
        XCTAssertEqual(values.cells.count, 2)
        XCTAssertNil(values.cells[1].lastAt)
        XCTAssertEqual(ShannonLearning.evidenceCount(try XCTUnwrap(values.active)), 12)
    }

    func testSkillsAndASkillDecodeAndABodyIsHiddenUnlessTheServerSaysOtherwise() throws {
        // `summary` in services/api/src/infra/http/skillRoutes.ts.
        let summary = """
        "id":"s1","name":"weekly-review","description":"ふりかえりの時","status":"trial","statusReason":null,"version":1,"pinned":false,
        "ownerVersion":false,"trial":{"baseVersion":null,"uses":2,"of":3},"uses":2,"successes":2,"copy":null,
        "createdAt":"2026-10-07T03:00:00.000Z","updatedAt":"2026-10-07T03:00:00.000Z"
        """
        let list = try JSONDecoder().decode(ShannonSkillsDTO.self, from: Data("{\"capacity\":{\"used\":1,\"limit\":20},\"skills\":[{\(summary)}]}".utf8))
        XCTAssertEqual(list.capacity, .init(used: 1, limit: 20))
        XCTAssertEqual(list.skills.first?.trial, .init(baseVersion: nil, uses: 2, of: 3))
        XCTAssertEqual(ShannonLearning.skillLine(try XCTUnwrap(list.skills.first)), "試用中 2/3")

        let shown = try JSONDecoder().decode(ShannonSkillDetailDTO.self, from: Data("""
        {\(summary),"body":"## 手順","bodyHidden":false,"versions":[{"version":1,"kind":"version","actor":"sleep","reason":"built","parent":null,
         "restores":null,"uses":2,"successes":2,"createdAt":"2026-10-07T03:00:00.000Z"},{"version":1,"kind":"snapshot","actor":"owner",
         "reason":"rollback","parent":null,"restores":null,"uses":0,"successes":0,"createdAt":"2026-10-07T04:00:00.000Z"}],"audit":[]}
        """.utf8))
        XCTAssertFalse(shown.bodyHidden)
        XCTAssertEqual(shown.skill.name, "weekly-review")
        XCTAssertEqual(shown.versions.count, 2)

        let silent = try JSONDecoder().decode(ShannonSkillDetailDTO.self, from: Data("{\(summary),\"body\":\"secret\"}".utf8))
        XCTAssertTrue(silent.bodyHidden, "a server that does not say the body may be shown is not trusted to have checked it")
    }

    // MARK: 手応え

    func testValueLinesAreTheChoicesSettledInTheLastSevenDaysNewestFirstWithAWordForEveryNumber() {
        let cells: [ShannonValuesDTO.Cell] = [
            .init(level: "root", choice: "", n: 40, mean: 0.3, lastAt: iso(hoursAgo: 1)),
            .init(level: "family", choice: "reach_out", n: 10, mean: 0.3, lastAt: iso(hoursAgo: 1)),
            .init(level: "band", choice: "show", context: "night", n: 4, mean: 0.7, lastAt: iso(hoursAgo: 1)),
            .init(level: "choice", choice: "show", n: 8, mean: 0.53, lastAt: iso(hoursAgo: 2)),
            .init(level: "choice", choice: "reach_out.share", n: 5, mean: 0.23, lastAt: iso(hoursAgo: 30)),
            .init(level: "choice", choice: "tool.study.search", n: 2, mean: 0.9, lastAt: iso(hoursAgo: 5)),
            .init(level: "choice", choice: "tier.luna", n: 6, mean: -0.12, lastAt: iso(hoursAgo: 50)),
            .init(level: "choice", choice: "look", n: 9, mean: 0.4, lastAt: iso(hoursAgo: 24 * 8)),
            .init(level: "choice", choice: "note", n: 0, mean: 0, lastAt: nil),
        ]
        let lines = ShannonLearning.recentLines(cells, now: now)
        XCTAssertEqual(lines.map(\.choice), ["show", "tool.study.search", "reach_out.share", "tier.luna"])
        XCTAssertEqual(lines.map(\.label), ["物語を見せる", "道具「study.search」を使う", "話しかける・面白かったことを伝えたい", "会話で、ふつうに考えて返す"])
        XCTAssertEqual(lines.map(\.value), ["+0.53", "+0.90", "+0.23", "−0.12"])
        XCTAssertEqual(lines.map(\.level), [.good, .few, .fair, .poor])
        XCTAssertEqual(lines[0].accessibilityLabel, "物語を見せる、手応えはよい、プラス0.53、8回")
        XCTAssertEqual(lines[3].accessibilityLabel, "会話で、ふつうに考えて返す、手応えはいまいち、マイナス0.12、6回")
        for line in lines { XCTAssertFalse(line.level.word.isEmpty) }
    }

    func testAtMostEightValueLines() {
        let cells = (0..<12).map { ShannonValuesDTO.Cell(level: "choice", choice: "tool.t\($0)", n: 3, mean: 0.1, lastAt: iso(hoursAgo: Double($0))) }
        XCTAssertEqual(ShannonLearning.recentLines(cells, now: now).count, 8)
    }

    func testANegligibleNegativeIsShownAsZeroWithAPlus() {
        XCTAssertEqual(ShannonLearning.signed(-0.001), "+0.00")
        XCTAssertEqual(ShannonLearning.spokenSigned(-0.25), "マイナス0.25")
    }

    // MARK: Skills and the version

    func testSkillLinesInWords() {
        XCTAssertEqual(ShannonLearning.skillLine(skill("a")), "成功 3/4")
        XCTAssertEqual(ShannonLearning.skillLine(.init(id: "b", name: "b", description: "b", status: "active", version: 1, pinned: false, uses: 0, successes: 0)), "まだ使っていません")
        let retired = ShannonSkillDTO(id: "c", name: "c", description: "c", status: "retired", statusReason: "low_success", version: 2, pinned: false, uses: 8, successes: 2)
        XCTAssertEqual(ShannonLearning.skillLine(retired), "やめた・うまくいかないことが続いた")
        XCTAssertEqual(ShannonLearning.skillAccessibilityLabel(skill("d", pinned: true)), "説明 d、成功 3/4、固定中")
    }

    func testTheRollbackTargetIsTheOneTheServerWouldChoose() {
        let values = ShannonValuesDTO(
            active: version("c", to: 30, hoursAgo: 1), frozen: false,
            versions: [version("a", to: 10, hoursAgo: 50), version("b", to: 20, hoursAgo: 26), version("c", to: 30, hoursAgo: 1)], cells: []
        )
        XCTAssertEqual(ShannonLearning.rollbackTarget(values)?.versionId, "b")
        // After a rollback to b (same evidence as b), a second rollback goes further back.
        let rolled = ShannonValuesDTO(
            active: version("d", to: 20, madeBy: "owner_rollback", hoursAgo: 0, frozen: true), frozen: true,
            versions: values.versions + [version("d", to: 20, madeBy: "owner_rollback", hoursAgo: 0, frozen: true)], cells: []
        )
        XCTAssertEqual(ShannonLearning.rollbackTarget(rolled)?.versionId, "a")
        XCTAssertNil(ShannonLearning.rollbackTarget(.init(active: version("a", to: 10, hoursAgo: 1), frozen: false, versions: [version("a", to: 10, hoursAgo: 1)], cells: [])))
    }

    // MARK: The model

    @MainActor
    func testAPartThatIsNotOfferedIsLeftOutAndTheTabGoesWhenNeitherIs() async {
        let client = FakeLearningClient()
        client.skills = .success(.init(capacity: .init(used: 1, limit: 20), skills: [skill("a")]))
        let yousu = ShannonYousuModel(client: client)
        await yousu.learning.reload()
        XCTAssertEqual(yousu.learning.skillsPhase, .loaded)
        XCTAssertEqual(yousu.learning.valuesPhase, .hidden)
        XCTAssertEqual(yousu.tabs, [.now, .learning, .mood])

        client.skills = .failure(ShannonAPIError.rejected(status: 403))
        await yousu.learning.reload()
        XCTAssertTrue(yousu.learning.isUnavailable)
        XCTAssertEqual(yousu.tabs, [.now, .mood])
    }

    @MainActor
    func testAFailedReadKeepsTheLastAnswer() async {
        let client = FakeLearningClient()
        client.skills = .success(.init(capacity: .init(used: 1, limit: 20), skills: [skill("a")]))
        let model = ShannonLearningModel(client: client)
        await model.reload()
        client.skills = .failure(ShannonAPIError.rejected(status: 500))
        await model.reload()
        XCTAssertEqual(model.skillsPhase, .unreadable)
        XCTAssertEqual(model.activeSkills.map(\.id), ["a"])
    }

    @MainActor
    func testAPinShowsAtOnceAndGoesBackWhenTheServerDoesNotTakeIt() async throws {
        let client = FakeLearningClient()
        client.skills = .success(.init(capacity: .init(used: 1, limit: 20), skills: [skill("a")]))
        let model = ShannonLearningModel(client: client)
        await model.reload()

        client.pinAnswer = .failure(ShannonAPIError.rejected(status: 500))
        let pin = Task { await model.setPinned("a", pinned: true) }
        while !client.pinIsHeld { await Task.yield() }
        XCTAssertTrue(model.activeSkills[0].pinned, "shown pinned before the server answers")
        XCTAssertTrue(model.pinsInFlight.contains("a"))
        // A read that arrives meanwhile does not undo what is on screen.
        await model.reload()
        XCTAssertTrue(model.activeSkills[0].pinned)
        client.releasePin()
        await pin.value
        XCTAssertFalse(model.activeSkills[0].pinned, "back where it was")
        XCTAssertEqual(model.skillNotice, ShannonGeneratedStrings.yousuLearningSkillsPinFailed)
        XCTAssertTrue(model.pinsInFlight.isEmpty)
    }

    @MainActor
    func testAPinTheServerTookShowsTheSkillAsItAnswered() async {
        let client = FakeLearningClient()
        client.skills = .success(.init(capacity: .init(used: 1, limit: 20), skills: [skill("a", pinned: true)]))
        let model = ShannonLearningModel(client: client)
        await model.reload()
        let answered = ShannonSkillDTO(id: "a", name: "a", description: "説明 a", status: "active", version: 2, pinned: false, uses: 4, successes: 3)
        client.pinAnswer = .success(answered)
        let unpin = Task { await model.setPinned("a", pinned: false) }
        while !client.pinIsHeld { await Task.yield() }
        XCTAssertFalse(model.activeSkills[0].pinned)
        client.releasePin()
        await unpin.value
        XCTAssertEqual(model.activeSkills[0], answered)
        XCTAssertNil(model.skillNotice)
        XCTAssertEqual(client.pins.map(\.1), [false])
    }

    @MainActor
    func testARollbackSendsTheConfirmedVersionOnceAndAFailureReadsTheTruthAgain() async throws {
        let client = FakeLearningClient()
        let before = ShannonValuesDTO(
            active: version("c", to: 30, hoursAgo: 1), frozen: false,
            versions: [version("b", to: 20, hoursAgo: 26), version("c", to: 30, hoursAgo: 1)], cells: []
        )
        client.values = .success(before)
        let model = ShannonLearningModel(client: client)
        await model.reload()
        let target = try XCTUnwrap(model.rollbackTarget)

        client.changeAnswer = .failure(ShannonAPIError.rejected(status: 409))
        await model.rollback(to: target)
        XCTAssertEqual(client.rollbackVersions, ["b"])
        XCTAssertEqual(model.valuesNotice, ShannonGeneratedStrings.yousuLearningVersionFailed)
        XCTAssertEqual(model.values, before)
        XCTAssertFalse(model.isChangingValues)

        let frozen = ShannonValuesDTO(active: version("d", to: 20, madeBy: "owner_rollback", hoursAgo: 0, frozen: true), frozen: true, versions: before.versions, cells: [])
        client.changeAnswer = .success(frozen)
        await model.rollback(to: target)
        XCTAssertEqual(model.values, frozen)
        XCTAssertNil(model.valuesNotice)
        XCTAssertEqual(client.rollbackVersions, ["b", "b"])

        client.changeAnswer = .success(before)
        await model.resume()
        XCTAssertEqual(client.resumes, 1)
        XCTAssertEqual(model.values?.frozen, false)
    }
    // MARK: Review of the 学び tab (2026-10-07)

    func testAWithheldSkillIsShownWithANeutralTitleAndANormalOneByItsDescription() throws {
        func decode(_ extra: String) throws -> ShannonSkillDTO {
            try JSONDecoder().decode(ShannonSkillDTO.self, from: Data("""
            {"id":"s1","name":"weekly-review","description":"ふりかえりの時","status":"active","version":1,"pinned":false,"uses":0,"successes":0\(extra)}
            """.utf8))
        }
        let normal = try decode("")
        XCTAssertFalse(normal.isWithheld)
        XCTAssertEqual(ShannonLearning.title(normal), "ふりかえりの時")
        XCTAssertFalse(try decode(#","hidden":false,"statusReason":"low_success","copy":{"documentId":"d","hold":null}"#).isWithheld)
        // The server says so; or, from a server that does not say, its own rule holds.
        for extra in [#","hidden":true"#, #","statusReason":"source_forgotten""#, #","copy":{"documentId":"d","hold":"withdrawn"}"#] {
            let skill = try decode(extra)
            XCTAssertTrue(skill.isWithheld, extra)
            XCTAssertEqual(ShannonLearning.title(skill), "（表示しないスキル）")
            XCTAssertFalse(ShannonLearning.skillAccessibilityLabel(skill).contains("ふりかえり"), extra)
        }
        XCTAssertEqual(try decode(#","copy":{"documentId":"d","hold":"withdrawn"}"#).copyHold, "withdrawn")
    }

    func testABodyIsReadOnlyWhenItIsShown() throws {
        let summary = #""id":"s1","name":"n","description":"d","status":"active","version":1,"pinned":false,"uses":0,"successes":0"#
        let missing = try JSONDecoder().decode(ShannonSkillDetailDTO.self, from: Data("{\(summary),\"bodyHidden\":true}".utf8))
        XCTAssertTrue(missing.bodyHidden)
        XCTAssertEqual(missing.body, "")
        XCTAssertTrue(try JSONDecoder().decode(ShannonSkillDetailDTO.self, from: Data("{\(summary)}".utf8)).bodyHidden)
        XCTAssertThrowsError(try JSONDecoder().decode(ShannonSkillDetailDTO.self, from: Data("{\(summary),\"bodyHidden\":false}".utf8)))
        let withheld = try JSONDecoder().decode(ShannonSkillDetailDTO.self, from: Data(
            "{\(summary),\"statusReason\":\"source_forgotten\",\"bodyHidden\":false,\"body\":\"secret\"}".utf8
        ))
        XCTAssertTrue(withheld.bodyHidden)
        XCTAssertEqual(withheld.body, "")
    }

    @MainActor
    func testAWithheldSkillCanBeUnpinnedButNeverPinned() async {
        let client = FakeLearningClient()
        func withheld(_ id: String, pinned: Bool) -> ShannonSkillDTO {
            .init(id: id, name: "（表示しないスキル）", description: "（表示しないスキル）", hidden: true, status: "active", copyHold: "withdrawn", version: 1, pinned: pinned, uses: 0, successes: 0)
        }
        client.skills = .success(.init(capacity: .init(used: 2, limit: 20), skills: [withheld("h", pinned: false), withheld("p", pinned: true)]))
        let model = ShannonLearningModel(client: client)
        await model.reload()

        await model.setPinned("h", pinned: true)
        XCTAssertTrue(client.pins.isEmpty, "never pinned")
        XCTAssertFalse(model.activeSkills[0].pinned)

        client.pinAnswer = .success(withheld("p", pinned: false))
        let unpin = Task { await model.setPinned("p", pinned: false) }
        while !client.pinIsHeld { await Task.yield() }
        XCTAssertFalse(model.activeSkills[1].pinned, "shown unpinned at once")
        client.releasePin()
        await unpin.value
        XCTAssertEqual(client.pins.map(\.0), ["p"])
        XCTAssertEqual(client.pins.map(\.1), [false])
        XCTAssertFalse(model.activeSkills[1].pinned)
        XCTAssertNil(model.skillNotice)
    }

    @MainActor
    func testAListReadThatStartedBeforeAPinNeverUndoesIt() async {
        let client = FakeLearningClient()
        client.skills = .success(.init(capacity: .init(used: 1, limit: 20), skills: [skill("a")]))
        let model = ShannonLearningModel(client: client)
        await model.reload()

        // A read starts and is held with the old list (not pinned).
        client.holdsSkillsReads = true
        let read = Task { await model.reload() }
        while !client.skillsReadIsHeld { await Task.yield() }
        client.holdsSkillsReads = false

        // The pin starts and the server takes it before the read answers.
        client.pinAnswer = .success(skill("a", pinned: true))
        let pin = Task { await model.setPinned("a", pinned: true) }
        while !client.pinIsHeld { await Task.yield() }
        client.releasePin()
        await pin.value
        XCTAssertTrue(model.activeSkills[0].pinned)

        client.releaseSkillsRead()
        await read.value
        XCTAssertTrue(model.activeSkills[0].pinned, "the older read is not applied")

        // A read that starts after the pin is applied as usual.
        client.skills = .success(.init(capacity: .init(used: 1, limit: 20), skills: [skill("a", pinned: true), skill("b")]))
        await model.reload()
        XCTAssertEqual(model.activeSkills.map(\.id), ["a", "b"])
    }

    @MainActor
    func testTheLearningTabIsOfferedOnlyAfterASuccessfulRead() async {
        let client = FakeLearningClient()
        client.skills = .failure(ShannonAPIError.rejected(status: 500))
        let yousu = ShannonYousuModel(client: client)
        XCTAssertEqual(yousu.tabs, [.now, .mood], "never offered before a read has answered")
        await yousu.learning.reload()
        XCTAssertEqual(yousu.tabs, [.now, .mood], "a failed read offers nothing")
        client.skills = .success(.init(capacity: .init(used: 0, limit: 20), skills: []))
        await yousu.learning.reload()
        XCTAssertEqual(yousu.tabs, [.now, .learning, .mood])
    }

    @MainActor
    func testAChangeWithoutAnAnswerIsCheckedAndNeverCalledAFailureWhenItArrived() async throws {
        let client = FakeLearningClient()
        let before = ShannonValuesDTO(
            active: version("c", to: 30, hoursAgo: 1), frozen: false,
            versions: [version("b", to: 20, hoursAgo: 26), version("c", to: 30, hoursAgo: 1)], cells: []
        )
        client.values = .success(before)
        let model = ShannonLearningModel(client: client)
        await model.reload()
        let target = try XCTUnwrap(model.rollbackTarget)

        // The answer timed out, but the server had written the rollback.
        client.changeAnswer = .failure(URLError(.timedOut))
        client.valuesAfterChange = ShannonValuesDTO(
            active: version("d", to: 20, madeBy: "owner_rollback", hoursAgo: 0, frozen: true), frozen: true, versions: before.versions, cells: []
        )
        await model.rollback(to: target)
        XCTAssertEqual(model.valuesNotice, ShannonGeneratedStrings.yousuLearningVersionArrived)
        XCTAssertEqual(model.values?.frozen, true)
        XCTAssertEqual(client.rollbackVersions, ["b"], "sent once")

        // Timed out and not written: then it did not go through.
        client.valuesAfterChange = nil
        client.values = .success(model.values!)
        await model.resume()
        XCTAssertEqual(model.valuesNotice, ShannonGeneratedStrings.yousuLearningVersionFailed)

        // Timed out and the server cannot be read either: not known.
        client.values = .failure(URLError(.notConnectedToInternet))
        await model.resume()
        XCTAssertEqual(model.valuesNotice, ShannonGeneratedStrings.yousuLearningVersionUnknown)
    }
}

