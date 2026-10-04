import XCTest
@testable import ShannonAppCore

private final class TestClock: @unchecked Sendable {
    var date = Date(timeIntervalSince1970: 1_790_000_000)
}

private final class FakeYousuClient: ShannonYousuServing, @unchecked Sendable {
    var reading: ShannonOpsReading?
    var loadError: Error?
    var outcome: ShannonOpsSendOutcome = .unknownDelivery
    var sent: [(type: ShannonOpsCommandType, target: String, key: String)] = []
    var afterSend: (() -> Void)?
    /// The pairing the readings belong to; nil as for an app that is not paired.
    var scope: String? = "server|owner|device-1"

    func opsReportScope(scopeKey: String) -> String? { scope }

    func loadOps(scopeKey: String) async throws -> ShannonOpsReading {
        if let loadError { throw loadError }
        guard let reading else { throw ShannonAPIError.invalidResponse }
        return reading
    }

    func sendOpsCommand(scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String) async -> ShannonOpsSendOutcome {
        sent.append((type, target, idempotencyKey))
        afterSend?()
        return outcome
    }

    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO { throw ShannonAPIError.rejected(status: 404) }
    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO { throw ShannonAPIError.rejected(status: 404) }
}

final class ShannonYousuOpsTests: XCTestCase {
    private func decode(_ json: String) throws -> ShannonOpsViewDTO {
        try JSONDecoder().decode(ShannonOpsViewDTO.self, from: Data(json.utf8))
    }

    private static let services = """
    [ { "id": "discord", "label": "discord", "category": "platform", "status": "running" },
      { "id": "twitter", "label": "twitter", "category": "platform", "status": "running" },
      { "id": "notion", "label": "notion", "category": "platform", "status": "degraded" },
      { "id": "youtube:live_chat", "label": "x", "category": "platform", "status": "stopped" },
      { "id": "minebot:bot", "label": "x", "category": "game", "status": "stopped" },
      { "id": "minecraft:main", "label": "x", "category": "game", "status": "running" },
      { "id": "minecraft:test", "label": "x", "category": "game", "status": "stopped" } ]
    """

    private func current(
        stale: Bool = false, commandsSupported: Bool = true, commands: String = "[]", services: String = ShannonYousuOpsTests.services,
        allowed: String = #"{ "serviceStart": ["discord", "notion", "youtube:live_chat"], "serviceStop": ["twitter", "notion", "minebot:bot"], "minecraft": true, "scheduleRun": true, "minebotStart": true }"#
    ) throws -> ShannonOpsViewDTO {
        try decode("""
        { "schemaVersion": 1, "receivedAt": "2026-10-03T07:00:00.000Z", "stale": \(stale), "staleAfterSeconds": 180,
          "commandsSupported": \(commandsSupported), "commands": \(commands), "allowed": \(allowed),
          "snapshot": { "reportedAt": "2026-10-03T06:59:58.000Z", "runtime": { "release": "v1", "startedAt": "2026-10-03T00:00:00.000Z" },
            "services": \(services), "minebot": [], "skills": [],
            "schedules": [ { "name": "朝の占い", "time": "0 8 * * *", "postedToday": true }, { "name": "夜の投稿", "time": "30 21 * * *" } ] } }
        """)
    }

    @MainActor
    private func loaded(_ view: ShannonOpsViewDTO, serverDate: Date? = nil) async -> (ShannonOpsModel, FakeYousuClient, TestClock) {
        let client = FakeYousuClient()
        client.reading = ShannonOpsReading(view: view, serverDate: serverDate)
        let clock = TestClock()
        let model = ShannonOpsModel(scopeKey: "owner", client: client, clock: { clock.date })
        await model.refresh()
        return (model, client, clock)
    }

    // MARK: Decoding holds the contract

    func testNoSnapshotIsStaleAndAllowsNothingWhateverTheFieldsSay() throws {
        let view = try decode(#"{ "snapshot": null, "receivedAt": null, "stale": false, "commandsSupported": true, "allowed": { "serviceStart": ["discord"], "serviceStop": ["twitter"], "minecraft": true, "scheduleRun": true, "minebotStart": true } }"#)
        XCTAssertNil(view.snapshot)
        XCTAssertTrue(view.stale)
        XCTAssertEqual(view.allowed, .nothing)
    }

    func testStaleOrUnsupportedAnswerAllowsNothing() throws {
        XCTAssertEqual(try current(stale: true).allowed, .nothing)
        XCTAssertEqual(try current(commandsSupported: false).allowed, .nothing)
        XCTAssertEqual(try current(commandsSupported: false, commands: #"[{ "id": "c", "type": "service.stop", "target": "twitter", "status": "done" }]"#).commands, [])
        // A missing `stale` or `allowed` is read as the cautious value.
        let bare = try decode(#"{ "snapshot": { "services": [ { "id": "discord", "status": "running" } ] }, "commandsSupported": true }"#)
        XCTAssertTrue(bare.stale)
        XCTAssertEqual(bare.allowed, .nothing)
        XCTAssertNotEqual(try current().allowed, .nothing)
    }

    func testUnknownValuesNeverFailTheAnswer() throws {
        let view = try decode("""
        { "stale": false, "commandsSupported": true, "receivedAt": "2026-10-03T07:00:00.000Z",
          "allowed": { "serviceStart": ["discord", 7], "serviceStop": [], "minecraft": false, "scheduleRun": false },
          "commands": [ { "id": "a", "type": "service.stop", "target": "twitter", "status": "a_state_of_a_later_server", "createdAt": "x" },
                        { "id": "b", "type": "a.type.of.a.later.server", "target": "x", "status": "done" }, "not a command" ],
          "snapshot": { "services": [ { "id": "discord", "status": "glowing" }, { "label": "no id" }, 3, { "id": "" } ],
            "minebot": [ { "id": "bot", "status": "running", "task": { "title": "Build", "steps": [ { "title": "A", "status": "later" }, { "nothing": 1 } ] } } ],
            "schedules": [ { "name": "朝" }, { "time": "08:00" } ], "kpi": { "postsToday": 1 }, "skills": [ { "name": "s" } ] } }
        """)
        XCTAssertEqual(view.snapshot?.services, [ShannonOpsServiceDTO(id: "discord", status: .unknown)])
        XCTAssertEqual(view.snapshot?.minebot.first?.task?.steps, [.init(title: "A", status: .pending)])
        XCTAssertEqual(view.snapshot?.schedules, [.init(name: "朝", time: "")])
        // Counters that were not all sent are not shown as zeros.
        XCTAssertNil(view.snapshot?.kpi)
        XCTAssertEqual(view.allowed.serviceStart, ["discord"])
        XCTAssertFalse(view.allowed.minebotStart)
        // An unknown state is not waited for; a command of an unknown type is dropped.
        XCTAssertEqual(view.commands.map(\.id), ["a"])
        XCTAssertEqual(view.commands.first?.status, .unknown)
        XCTAssertFalse(view.commands[0].status.isOpen)
        XCTAssertEqual(ShannonOpsText.commandStatusLabel(.unknown), "不明")
    }

    func testTheRecordHoldsTwentyCommands() throws {
        let many = (0..<25).map { #"{ "id": "c\#($0)", "type": "service.stop", "target": "twitter", "status": "done" }"# }.joined(separator: ",")
        XCTAssertEqual(try current(commands: "[\(many)]").commands.count, 20)
    }

    // MARK: A control only for what the server allowed

    func testServiceActionsAreOnlyWhatTheServerListed() throws {
        let view = try current()
        let services = Dictionary(uniqueKeysWithValues: view.snapshot!.services.map { ($0.id, $0) })
        func types(_ id: String, _ allowed: ShannonOpsAllowedDTO = view.allowed) -> [ShannonOpsCommandType] {
            ShannonOpsText.serviceActions(services[id]!, allowed: allowed).map(\.type)
        }
        // Discord may be started and never stopped: running, it has no control at all.
        XCTAssertEqual(types("discord"), [])
        XCTAssertEqual(types("twitter"), [.serviceStop])
        // 不調: both, each only because it is listed.
        XCTAssertEqual(types("notion"), [.serviceStart, .serviceStop])
        // Stopped, and listed for a start only: no stop for a stopped service even when listed.
        XCTAssertEqual(types("youtube:live_chat"), [.serviceStart])
        // The Minebot body never gets a plain start; stopped, it has nothing to stop.
        XCTAssertEqual(types("minebot:bot"), [])
        XCTAssertEqual(types("minecraft:main"), [.minecraftStop])
        XCTAssertEqual(types("minecraft:test"), [.minecraftStart])
        for id in services.keys { XCTAssertEqual(types(id, .nothing), [], id) }
        // A server is commanded only through `minecraft`, never through the service lists.
        let lists = ShannonOpsAllowedDTO(serviceStart: ["minecraft:test"], serviceStop: ["minecraft:main"], minecraft: false, scheduleRun: false, minebotStart: false)
        XCTAssertEqual(types("minecraft:main", lists), [])
        XCTAssertEqual(types("minecraft:test", lists), [])
        XCTAssertNil(ShannonOpsText.scheduleAction(view.snapshot!.schedules[0], allowed: lists))
        XCTAssertEqual(ShannonOpsText.scheduleAction(view.snapshot!.schedules[0], allowed: view.allowed)?.postedToday, true)
    }

    @MainActor
    func testModelOffersNothingWhenTheReportIsStaleOrTheServerUnreachable() async throws {
        let (stale, _, _) = await loaded(try current(stale: true))
        XCTAssertTrue(stale.hasReport)
        XCTAssertFalse(stale.isCurrent())
        XCTAssertTrue(stale.needsAttention)
        XCTAssertEqual(stale.attentionReason(), "報告が届いていません")
        for service in stale.snapshot!.services {
            XCTAssertEqual(stale.actions(for: service), [])
            XCTAssertNil(stale.minebotStartServers(for: service))
        }
        for schedule in stale.snapshot!.schedules { XCTAssertNil(stale.action(for: schedule)) }

        let (model, client, _) = await loaded(try current())
        XCTAssertFalse(model.actions(for: model.snapshot!.services[1]).isEmpty)
        client.loadError = URLError(.cannotConnectToHost)
        await model.refresh()
        // The last report stays on screen, without a single control.
        XCTAssertNotNil(model.snapshot)
        XCTAssertNotNil(model.unreachableMessage)
        XCTAssertEqual(model.allowed(), .nothing)
        XCTAssertEqual(model.actions(for: model.snapshot!.services[1]), [])
        client.loadError = nil
        await model.refresh()
        XCTAssertNil(model.unreachableMessage)
        XCTAssertFalse(model.actions(for: model.snapshot!.services[1]).isEmpty)
    }

    @MainActor
    func testTheMarkSaysWhyAndCountsOnlyOperationsOfTheLastHour() async throws {
        let healthy = #"[ { "id": "twitter", "label": "twitter", "category": "platform", "status": "running" } ]"#
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let iso = { (seconds: Double) in now.addingTimeInterval(-seconds).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }

        // All well: no mark, no reason.
        let (calm, _, _) = await loaded(try current(services: healthy))
        XCTAssertFalse(calm.needsAttention)
        XCTAssertNil(calm.attentionReason())

        // A service that is not well, by its name.
        let (unwell, client, clock) = await loaded(try current())
        XCTAssertEqual(unwell.attentionReason(), "Notionが不調")

        // An operation that failed 50 minutes ago counts; one that expired two hours ago does not.
        let commands = """
        [ { "id": "a", "type": "service.stop", "target": "twitter", "status": "failed", "createdAt": "\(iso(3_000))", "finishedAt": "\(iso(3_000))" },
          { "id": "b", "type": "schedule.run", "target": "朝の占い", "status": "expired", "createdAt": "\(iso(7_500))", "expiresAt": "\(iso(7_200))" } ]
        """
        let (failed, failedClient, failedClock) = await loaded(try current(commands: commands, services: healthy))
        XCTAssertEqual(failed.attentionReason(), "X（Twitter）の操作が失敗")
        XCTAssertNil(failed.recentProblemCommand(at: now.addingTimeInterval(11 * 60)), "older than an hour: the record keeps it, the mark does not")
        let expiredOnly = """
        [ { "id": "b", "type": "schedule.run", "target": "朝の占い", "status": "expired", "createdAt": "\(iso(400))", "expiresAt": "\(iso(100))" } ]
        """
        failedClient.reading = ShannonOpsReading(view: try current(commands: expiredOnly, services: healthy), serverDate: nil)
        failedClock.date = now
        await failed.refresh()
        XCTAssertEqual(failed.attentionReason(), "予定「朝の占い」の操作が期限切れ")

        // The server cannot be reached: said before anything else.
        client.loadError = URLError(.cannotConnectToHost)
        await unwell.refresh()
        XCTAssertEqual(unwell.attentionReason(), "サーバーに届きません")
        _ = clock

        // Before the first report ever arrived there is no mark at all, whatever else is true.
        let empty = FakeYousuClient()
        empty.loadError = URLError(.cannotConnectToHost)
        let never = ShannonOpsModel(scopeKey: "owner", client: empty)
        await never.refresh()
        XCTAssertFalse(never.hasReport)
        XCTAssertFalse(never.needsAttention)
        XCTAssertNil(never.attentionReason())
    }

    @MainActor
    func testAServerDownAtLaunchIsMarkedOnceAReportHadArrivedBeforeForThisPairing() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-ops-tests-\(UUID().uuidString)"))
        // An earlier launch: a report arrived for this pairing.
        let client = FakeYousuClient()
        client.reading = ShannonOpsReading(view: try current(), serverDate: nil)
        let earlier = ShannonOpsModel(scopeKey: "local-owner", client: client, defaults: defaults)
        await earlier.refresh()
        XCTAssertTrue(earlier.reportArrivedBefore)

        // This launch: the server cannot be reached, so no report is in memory.
        let down = FakeYousuClient()
        down.loadError = URLError(.cannotConnectToHost)
        let launched = ShannonOpsModel(scopeKey: "local-owner", client: down, defaults: defaults)
        XCTAssertNil(launched.attentionReason(), "not read yet: nothing is claimed")
        await launched.refresh()
        XCTAssertFalse(launched.hasReport)
        XCTAssertEqual(launched.attentionReason(), "サーバーに届きません")
        XCTAssertTrue(launched.needsAttention)

        // Another pairing (paired again, or another server) never had a report: no mark.
        let repaired = FakeYousuClient()
        repaired.loadError = URLError(.cannotConnectToHost)
        repaired.scope = "server|owner|device-2"
        let other = ShannonOpsModel(scopeKey: "local-owner", client: repaired, defaults: defaults)
        await other.refresh()
        XCTAssertFalse(other.reportArrivedBefore)
        XCTAssertNil(other.attentionReason())

        // An app that is not paired remembers nobody's 運用.
        let unpaired = FakeYousuClient()
        unpaired.loadError = URLError(.cannotConnectToHost)
        unpaired.scope = nil
        let lonely = ShannonOpsModel(scopeKey: "local-owner", client: unpaired, defaults: defaults)
        await lonely.refresh()
        XCTAssertNil(lonely.attentionReason())

        // An older server without 運用 hides it, mark and all.
        let older = FakeYousuClient()
        older.loadError = ShannonAPIError.rejected(status: 404)
        let gone = ShannonOpsModel(scopeKey: "local-owner", client: older, defaults: defaults)
        await gone.refresh()
        XCTAssertNil(gone.attentionReason())

        // Without a place to keep it, nothing is remembered.
        let forgetful = ShannonOpsModel(scopeKey: "local-owner", client: down)
        await forgetful.refresh()
        XCTAssertNil(forgetful.attentionReason())

        // The pairing is not written as it is.
        XCTAssertFalse(defaults.dictionaryRepresentation().keys.contains { $0.contains("device-1") })
        // Unpairing or pairing again forgets it, and a mark already shown drops at once.
        XCTAssertNotNil(launched.attentionReason())
        ShannonOpsModel.forgetArrivedReports(in: defaults)
        XCTAssertNil(launched.attentionReason())
        XCTAssertNil(earlier.snapshot)
        let afterUnpair = ShannonOpsModel(scopeKey: "local-owner", client: down, defaults: defaults)
        await afterUnpair.refresh()
        XCTAssertFalse(afterUnpair.reportArrivedBefore)
        XCTAssertNil(afterUnpair.attentionReason())
    }

    @MainActor
    func testARefusedConnectionIsNotAnOpsMarkAndIsSaidInItsOwnWords() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-ops-tests-\(UUID().uuidString)"))
        let client = FakeYousuClient()
        client.reading = ShannonOpsReading(view: try current(), serverDate: nil)
        let clock = TestClock()
        let model = ShannonOpsModel(scopeKey: "local-owner", client: client, clock: { clock.date }, defaults: defaults)
        await model.refresh()
        XCTAssertEqual(model.attentionReason(), "Notionが不調")
        // The device was unpaired elsewhere: every reading is refused.
        client.loadError = ShannonAPIError.rejected(status: 401)
        await model.refresh()
        XCTAssertTrue(model.connectionIsInvalid)
        XCTAssertNil(model.attentionReason())
        XCTAssertFalse(model.needsAttention)
        XCTAssertEqual(model.unreachableMessage, ShannonGeneratedStrings.opsConnectionInvalid)
        XCTAssertEqual(model.allowed(), .nothing)
        // Let in again: the mark is what 運用 says.
        client.loadError = nil
        await model.refresh()
        XCTAssertFalse(model.connectionIsInvalid)
        XCTAssertEqual(model.attentionReason(), "Notionが不調")
    }

    @MainActor
    func testAReportThatAgesPastThreeMinutesLosesItsControlsWithoutANewReading() async throws {
        // Read when the report was already 100 seconds old on the server's clock.
        let received = ShannonYousuTime.date("2026-10-03T07:00:00.000Z")!
        let (model, client, clock) = await loaded(try current(), serverDate: received.addingTimeInterval(100))
        let twitter = model.snapshot!.services[1]
        let stop = ShannonOpsAction(type: .serviceStop, target: "twitter", name: "X（Twitter）")
        XCTAssertEqual(model.actions(for: twitter).map(\.type), [.serviceStop])
        XCTAssertTrue(model.canSend(stop))

        clock.date.addTimeInterval(79)
        XCTAssertTrue(model.isCurrent())
        clock.date.addTimeInterval(2)
        XCTAssertFalse(model.isCurrent())
        XCTAssertEqual(model.actions(for: twitter), [])
        XCTAssertFalse(model.canSend(stop))

        // A confirmation that stayed open sends nothing.
        await model.send(stop)
        XCTAssertTrue(client.sent.isEmpty)
        XCTAssertEqual(model.notice, .problem(title: "送れませんでした", message: ShannonOpsText.staleBeforeSending))
    }

    @MainActor
    func testAgeIsCountedOnThisDeviceWhenTheServersClockIsMissingAndAnUnreadableTimeIsStale() async throws {
        // No Date header: the report was received 170 seconds before this device read it.
        let client = FakeYousuClient()
        client.reading = ShannonOpsReading(view: try current(), serverDate: nil)
        let clock = TestClock()
        clock.date = ShannonYousuTime.date("2026-10-03T07:00:00.000Z")!.addingTimeInterval(170)
        let model = ShannonOpsModel(scopeKey: "owner", client: client, clock: { clock.date })
        await model.refresh()
        XCTAssertTrue(model.isCurrent())
        clock.date.addTimeInterval(11)
        XCTAssertFalse(model.isCurrent())
        XCTAssertEqual(model.allowed(), .nothing)

        let unreadable = try decode(#"{ "stale": false, "commandsSupported": true, "receivedAt": "sometime", "allowed": { "serviceStart": [], "serviceStop": ["twitter"], "minecraft": false, "scheduleRun": false }, "snapshot": { "services": [ { "id": "twitter", "status": "running" } ] } }"#)
        let (undated, _, _) = await loaded(unreadable)
        XCTAssertFalse(undated.isCurrent())
        XCTAssertEqual(undated.actions(for: undated.snapshot!.services[0]), [])
    }

    func testLabServersAreNeverOffered() throws {
        let allowed = ShannonOpsAllowedDTO(serviceStart: ["minecraft:progressive-lab-a"], serviceStop: ["minecraft:progressive-lab-a"], minecraft: true, scheduleRun: true, minebotStart: true)
        let lab = ShannonOpsServiceDTO(id: "minecraft:progressive-lab-a", status: .running)
        XCTAssertEqual(ShannonOpsText.serviceActions(lab, allowed: allowed), [])
        XCTAssertEqual(ShannonOpsText.serviceActions(.init(id: "minecraft:progressive-lab-b", status: .stopped), allowed: allowed), [])
        XCTAssertEqual(ShannonOpsText.minebotServers([lab, .init(id: "minecraft:main", status: .running)]).map(\.id), ["minecraft:main"])
    }

    @MainActor
    func testACancelledReadClaimsNothingAndAnUnreachableServerIsNotPolledFast() async throws {
        let (model, client, _) = await loaded(try current(commands: #"[{ "id": "a", "type": "service.stop", "target": "twitter", "status": "pending" }]"#))
        XCTAssertEqual(model.pollInterval, .seconds(3))
        client.loadError = URLError(.cancelled)
        await model.refresh()
        XCTAssertNil(model.unreachableMessage)
        XCTAssertTrue(model.isCurrent())
        client.loadError = URLError(.timedOut)
        await model.refresh()
        XCTAssertNotNil(model.unreachableMessage)
        XCTAssertEqual(model.pollInterval, .seconds(30))

        let fresh = ShannonOpsModel(scopeKey: "owner", client: client)
        client.loadError = CancellationError()
        await fresh.refresh()
        XCTAssertFalse(fresh.didLoad)
        XCTAssertNil(fresh.unreachableMessage)
    }

    @MainActor
    func testAnAcceptedCommandWaitsEvenBeforeTheRecordShowsIt() async throws {
        let (model, client, clock) = await loaded(try current())
        let stop = ShannonOpsAction(type: .serviceStop, target: "twitter", name: "X（Twitter）")
        client.outcome = .accepted(.init(id: "cmd-9", type: .serviceStop, target: "twitter", status: .pending, createdAt: ""))
        // The reading after the send still predates the command.
        await model.send(stop)
        XCTAssertTrue(model.commands.isEmpty)
        XCTAssertTrue(model.isWaiting(target: "twitter"))
        XCTAssertEqual(model.actions(for: model.snapshot!.services[1]), [])
        XCTAssertFalse(model.canSend(stop))
        XCTAssertEqual(model.pollInterval, .seconds(3))
        // It is not waited for beyond the time it may be claimed in.
        clock.date.addTimeInterval(301)
        XCTAssertFalse(model.isWaiting(target: "twitter"))
    }

    func testSchedulesOfOneNameAreOne() throws {
        let view = try decode(#"{ "stale": false, "commandsSupported": true, "receivedAt": "2026-10-03T07:00:00.000Z", "snapshot": { "services": [], "schedules": [ { "name": "朝", "time": "08:00" }, { "name": "朝", "time": "09:00" } ] } }"#)
        XCTAssertEqual(view.snapshot?.schedules, [.init(name: "朝", time: "08:00")])
    }

    @MainActor
    func testACommandThatIsNotOfferedIsNeverSent() async throws {
        let (model, client, _) = await loaded(try current())
        for action in [
            ShannonOpsAction(type: .serviceStop, target: "discord", name: "Discord"),
            ShannonOpsAction(type: .serviceStart, target: "minebot:bot", name: "Minebot の体"),
            ShannonOpsAction(type: .serviceStart, target: "not-in-the-report", name: "x"),
            ShannonOpsAction(type: .scheduleRun, target: "無い予定", name: "無い予定"),
            // The body may join only a server that is running now.
            ShannonOpsAction(type: .minebotStart, target: "minecraft:test", name: "x"),
        ] {
            XCTAssertFalse(model.canSend(action), action.id)
            await model.send(action)
        }
        XCTAssertTrue(client.sent.isEmpty)
        XCTAssertEqual(model.notice, .problem(title: "送れませんでした", message: ShannonOpsText.noLongerAllowed))
        XCTAssertTrue(model.canSend(.init(type: .minebotStart, target: "minecraft:main", name: "x")))
        XCTAssertTrue(model.canSend(.init(type: .scheduleRun, target: "朝の占い", name: "朝の占い", postedToday: true)))
    }

    @MainActor
    func testMinebotBodyStartNeedsTheServersWordAndARunningServer() async throws {
        let (model, _, _) = await loaded(try current())
        let body = model.snapshot!.services.first { $0.id == ShannonOpsText.minebotBody }!
        XCTAssertEqual(model.minebotStartServers(for: body)?.map(\.id), ["minecraft:main"])
        XCTAssertNil(model.minebotStartServers(for: model.snapshot!.services[0]))

        let (refusing, _, _) = await loaded(try current(allowed: #"{ "serviceStart": [], "serviceStop": [], "minecraft": true, "scheduleRun": true }"#))
        XCTAssertNil(refusing.minebotStartServers(for: body))
    }

    // MARK: What happened to a command

    @MainActor
    func testSendingReportsWhatTheServerSaid() async throws {
        let (model, client, _) = await loaded(try current())
        let stop = ShannonOpsAction(type: .serviceStop, target: "twitter", name: "X（Twitter）")

        client.outcome = .refused(status: 409, code: "OPS_STALE")
        await model.send(stop)
        XCTAssertEqual(model.notice, .problem(title: "送れませんでした", message: "旧ランタイムからの報告が届いていないので、操作を受け付けられません。"))

        client.outcome = .refused(status: 500, code: nil)
        await model.send(stop)
        XCTAssertEqual(model.notice, .problem(title: "送れませんでした", message: "操作が受け付けられませんでした（500）。"))

        client.outcome = .unknownDelivery
        await model.send(stop)
        // What may have arrived is never called "not sent".
        XCTAssertEqual(model.notice, .problem(title: "届いたか分かりません", message: ShannonOpsText.unknownDelivery))
        client.outcome = .unreadable
        await model.send(stop)
        XCTAssertEqual(model.notice, .problem(title: "応答を読み取れませんでした", message: ShannonOpsText.unreadableAnswer))

        // Accepted: the result is whatever the record says on the next reading.
        let accepted = ShannonOpsCommandDTO(id: "cmd-1", type: .serviceStop, target: "twitter", status: .pending, createdAt: "2026-10-03T07:00:10.000Z")
        client.outcome = .accepted(accepted)
        client.afterSend = { [self] in
            client.reading = ShannonOpsReading(view: try! current(commands: #"[{ "id": "cmd-1", "type": "service.stop", "target": "twitter", "status": "claimed", "createdAt": "2026-10-03T07:00:10.000Z" }]"#))
        }
        await model.send(stop)
        XCTAssertEqual(model.noticedCommand?.status, .claimed)
        XCTAssertEqual(model.pollInterval, .seconds(3))
        XCTAssertTrue(model.isWaiting(target: "twitter"))
        // While it waits, the same target offers nothing more.
        XCTAssertEqual(model.actions(for: model.snapshot!.services[1]), [])

        client.reading = ShannonOpsReading(view: try current(commands: #"[{ "id": "cmd-1", "type": "service.stop", "target": "twitter", "status": "failed", "code": "no_report", "createdAt": "2026-10-03T07:00:10.000Z" }]"#))
        await model.refresh()
        XCTAssertEqual(model.noticedCommand?.status, .failed)
        XCTAssertEqual(ShannonOpsText.commandReason(model.noticedCommand!), "結果が届きませんでした（実行されたかどうかは、状態を見て確かめてください）")
        XCTAssertEqual(model.pollInterval, .seconds(30))

        // One press, one key; a failed delivery was not sent again.
        XCTAssertEqual(client.sent.count, 5)
        XCTAssertEqual(Set(client.sent.map(\.key)).count, 5)
    }

    @MainActor
    func testWaitingIsCountedForTheRightRow() async throws {
        let (model, _, _) = await loaded(try current(commands: """
        [ { "id": "a", "type": "minebot.start", "target": "minecraft:main", "status": "pending" },
          { "id": "b", "type": "schedule.run", "target": "twitter", "status": "claimed" } ]
        """))
        XCTAssertTrue(model.isWaiting(target: ShannonOpsText.minebotBody))
        // Starting the body is not an operation on the server it joins.
        XCTAssertFalse(model.isWaiting(target: "minecraft:main"))
        // A schedule and a service of the same name are different targets.
        XCTAssertTrue(model.isWaiting(target: "twitter", schedule: true))
        XCTAssertFalse(model.isWaiting(target: "twitter"))
    }

    @MainActor
    func testAnOlderServerHidesTheScreen() async {
        let client = FakeYousuClient()
        client.loadError = ShannonAPIError.rejected(status: 404)
        let model = ShannonOpsModel(scopeKey: "owner", client: client)
        await model.refresh()
        XCTAssertFalse(model.isSupported)
        XCTAssertFalse(model.hasReport)
        XCTAssertFalse(model.needsAttention)
    }

    // MARK: Wording

    func testConfirmationsAreWordForWord() {
        XCTAssertEqual(
            ShannonOpsText.confirmationText(.minebotStart, name: "Minecraft サーバー 1.21.1-play"),
            "Minebot の体を、Minecraft サーバー 1.21.1-play に入らせて起動しますか？\n\n起動すると、課金つきの計画機能が動き始めます。止めるまで費用がかかります。この画面には費用は表示されません。\nいま動くのは、ラボでネザーに到達した版より古い版です。"
        )
        XCTAssertEqual(
            ShannonOpsText.confirmationText(.scheduleRun, name: "朝の占い", postedToday: true),
            "予定「朝の占い」を、いますぐ実行しますか？\n\n実行すると、この予定の処理がいま動き、実際に公開の場（X（Twitter）や YouTube など）へ投稿・返信されます。取り消せません。\n今日は、すでに投稿済みです。実行すると、もう一度投稿されます。"
        )
        for unknown in [Bool?.none, false] {
            XCTAssertEqual(
                ShannonOpsText.confirmationText(.scheduleRun, name: "夜の投稿", postedToday: unknown),
                "予定「夜の投稿」を、いますぐ実行しますか？\n\n実行すると、この予定の処理がいま動き、実際に公開の場（X（Twitter）や YouTube など）へ投稿・返信されます。取り消せません。\n今日すでに投稿済みの場合でも、もう一度投稿されます。"
            )
        }
        for type in [ShannonOpsCommandType.serviceStop, .minecraftStop] {
            XCTAssertEqual(
                ShannonOpsText.confirmationText(type, name: "YouTube ライブチャット"),
                "YouTube ライブチャット を停止しますか？\n\n止めている間、この機能は動きません（もう一度動かすには、ここから開始します）。"
            )
        }
        for type in [ShannonOpsCommandType.serviceStart, .minecraftStart] {
            XCTAssertEqual(ShannonOpsText.confirmationText(type, name: "Minecraft サーバー 1.21.4-test"), "Minecraft サーバー 1.21.4-test を開始しますか？")
        }
    }

    func testNamesStatesAndResults() {
        XCTAssertEqual(ShannonOpsText.serviceName(id: "minebot:bot", label: "minebot:bot"), "Minebot の体")
        XCTAssertEqual(ShannonOpsText.serviceName(id: "minecraft:1.21.1-play", label: "x"), "Minecraft サーバー 1.21.1-play")
        XCTAssertEqual(ShannonOpsText.serviceName(id: "radar", label: "Radar"), "Radar")
        XCTAssertEqual(ShannonOpsText.serviceName(id: "radar", label: "radar"), "radar")
        XCTAssertEqual(ShannonOpsStatus.allCasesForTests.map(ShannonOpsText.statusLabel), ["動いている", "止まっている", "不調", "不明"])
        // A report that is not current is never worded as the present.
        XCTAssertEqual(ShannonOpsStatus.allCasesForTests.map(ShannonOpsText.staleStatusLabel), ["動いていた", "止まっていた", "不調だった", "不明"])
        XCTAssertEqual(ShannonOpsText.commandTargetName(type: .minebotStart, target: "minecraft:main"), "Minebot の体（Minecraft サーバー main に入る）")
        XCTAssertEqual(ShannonOpsText.commandTargetName(type: .scheduleRun, target: "朝の占い"), "予定「朝の占い」")
        XCTAssertEqual(ShannonOpsText.commandCodeLabel("already_stopped"), "すでに止まっていました")
        XCTAssertEqual(ShannonOpsText.commandCodeLabel("already_stopped", type: .minebotStart), "選んだ Minecraft サーバーが止まっていたので、起動しませんでした")
        XCTAssertEqual(ShannonOpsText.commandCodeLabel("a_code_of_a_later_server"), "a_code_of_a_later_server")
        XCTAssertEqual(
            ShannonOpsText.commandReason(.init(id: "x", type: .serviceStop, target: "twitter", status: .expired, createdAt: "")),
            "5 分以内に受け取られなかったので、実行していません"
        )
        XCTAssertEqual(ShannonOpsText.refusal(status: 403, code: "TARGET_NOT_ALLOWED"), "その対象は、ここからは操作できません。")
        XCTAssertEqual(ShannonOpsText.holdTitle(.minebotStart), "長押しで起動")
        XCTAssertEqual(ShannonOpsText.holdTitle(.scheduleRun), "長押しで実行")
        XCTAssertEqual(ShannonOpsText.postedTodayLabel(true), "今日は投稿済み")
        XCTAssertNil(ShannonOpsText.postedTodayLabel(nil))
    }

    func testScheduleTimes() {
        XCTAssertEqual(ShannonOpsText.scheduleTime("0 8 * * *"), "毎日 8:00")
        XCTAssertEqual(ShannonOpsText.scheduleTime("30 21 */1 * *"), "毎日 21:30")
        XCTAssertEqual(ShannonOpsText.scheduleTime("15 * * * *"), "毎時 15 分")
        XCTAssertEqual(ShannonOpsText.scheduleTime("0 */6 * * *"), "6 時間ごと（0 分）")
        XCTAssertEqual(ShannonOpsText.scheduleTime("0 8 * * 1"), "0 8 * * 1")
        XCTAssertEqual(ShannonOpsText.scheduleTime("08:00"), "08:00")
    }

    func testServicesAreGroupedWithoutLosingOne() throws {
        let groups = ShannonOpsGroups(try current().snapshot!.services)
        XCTAssertEqual(groups.services.map(\.id), ["discord", "twitter", "notion", "youtube:live_chat"])
        XCTAssertEqual(groups.minebot.map(\.id), ["minebot:bot"])
        XCTAssertEqual(groups.minecraft.map(\.id), ["minecraft:main", "minecraft:test"])
    }

    func testHTTPDateIsReadOnTheServersClock() {
        XCTAssertEqual(ShannonAPIClient.httpDate("Sat, 03 Oct 2026 07:00:00 GMT"), ShannonYousuTime.date("2026-10-03T07:00:00.000Z"))
        XCTAssertNil(ShannonAPIClient.httpDate("yesterday"))
    }
}

private extension ShannonOpsStatus {
    static let allCasesForTests: [ShannonOpsStatus] = [.running, .stopped, .degraded, .unknown]
}
