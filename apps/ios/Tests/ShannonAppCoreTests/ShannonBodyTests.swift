import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonBodyTests: XCTestCase {
    // MARK: The form

    func testTheFormDefaultsToWaterlightAndIsRememberedPerDevice() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-body-tests-\(UUID().uuidString)"))
        XCTAssertEqual(ShannonForm.current(defaults: defaults), .waterlight)
        XCTAssertFalse(ShannonBodyPreference.reportsTouch(defaults: defaults))
        defaults.set(ShannonForm.live2d.rawValue, forKey: ShannonForm.storageKey)
        XCTAssertEqual(ShannonForm.current(defaults: defaults), .live2d)
        defaults.set("hologram", forKey: ShannonForm.storageKey)
        XCTAssertEqual(ShannonForm.current(defaults: defaults), .waterlight)
        XCTAssertEqual(ShannonForm.allCases.map(\.japaneseName), ["水の光の目", "Live2Dの姿"])
        XCTAssertEqual(ShannonBodyCopy.nowLine(face: ShannonFace(expression: .joyful), doing: "物語を書いています"), "いま：うれしい・物語を書いています")
        XCTAssertEqual(ShannonBodyCopy.nowLine(face: ShannonFace(expression: .calm, feeling: .proud), doing: nil), "いま：得意げ")
    }

    // MARK: The embed page

    func testTheEmbedPageIsBundledAsAFolderWithItsFilesInPlace() throws {
        let folder = try XCTUnwrap(ShannonLive2DStage.embedFolder)
        for file in ["embed.html", "embed.js", "embed.css", "assets.js", "version.json", "live2d/live2d.js", "live2d/live2dcubismcore.min.js"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent(file).path), file)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.deletingLastPathComponent().appendingPathComponent("NOTICE.txt").path))
        let version = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("version.json"))) as? [String: Any]
        XCTAssertEqual(version?["modelUpdatedAt"] as? String, "2026-10-02T17:09:06.469Z")
    }

    func testCommandsAreGuardedCallsWithEncodedArguments() {
        XCTAssertEqual(
            ShannonLive2DCommand.express(expression: "joyful", feeling: "proud", seconds: 8).javaScript,
            #"window.shannonBody&&window.shannonBody.express("joyful","proud",8.000);"#)
        XCTAssertEqual(
            ShannonLive2DCommand.express(expression: "calm", feeling: nil, seconds: nil).javaScript,
            #"window.shannonBody&&window.shannonBody.express("calm",undefined,undefined);"#)
        // A name from the server can never end the string and become script.
        let hostile = ShannonLive2DCommand.express(expression: "\");alert(1);(\"", feeling: "a\u{2028}b</script>", seconds: nil).javaScript
        XCTAssertTrue(hostile.contains(#""\");alert(1);(\"""#))
        XCTAssertFalse(hostile.contains("\u{2028}"))
        XCTAssertEqual(ShannonLive2DCommand.setMouthLevel(1.7).javaScript, "window.shannonBody&&window.shannonBody.setMouthLevel(1.000);")
        XCTAssertEqual(ShannonLive2DCommand.setMouthLevel(.infinity).javaScript, "window.shannonBody&&window.shannonBody.setMouthLevel(1.000);")
        XCTAssertEqual(ShannonLive2DCommand.setPhase(.listening).javaScript, #"window.shannonBody&&window.shannonBody.setPhase("listening");"#)
        XCTAssertEqual(ShannonLive2DCommand.setPaused(true).javaScript, "window.shannonBody&&window.shannonBody.setPaused(true);")
        XCTAssertEqual(
            ShannonLive2DCommand.setLayout(.init(mode: .full, scale: 1.5, offsetX: -12, offsetY: 30)).javaScript,
            #"window.shannonBody&&window.shannonBody.setLayout({mode:"full",scale:1.500,offsetX:-12.000,offsetY:30.000});"#)
        XCTAssertEqual(
            ShannonLive2DCommand.setPresence(.init(expression: "joyful", feeling: nil, intensity: 0.5, doing: "drafting", awaitingReaction: 2)).javaScript,
            #"window.shannonBody&&window.shannonBody.setPresence({expression:"joyful",feeling:null,intensity:0.500,doing:"drafting",awaitingReaction:2});"#)
        XCTAssertEqual(
            ShannonLive2DCommand.expressEmotion(name: "cuteAngry", intensity: 2).javaScript,
            #"window.shannonBody&&window.shannonBody.expressEmotion("cuteAngry",1.000);"#)
    }

    func testMessagesOfThePageAreReadStrictly() {
        let touch: [String: Any] = ["type": "pet", "durationMs": 1800.4, "strength": 0.42, "ongoing": false]
        XCTAssertEqual(
            ShannonLive2DMessage(body: ["type": "touch", "id": "7d1c-0001", "occurredAt": "2026-10-03T03:00:00.000Z", "touch": touch]),
            .touch(.init(id: "7d1c-0001", occurredAt: "2026-10-03T03:00:00.000Z", kind: .pet, durationMs: 1800, strength: 0.42, ongoing: false)))
        let asking: [String: Any] = ["type": "holdHand", "durationMs": 2000, "strength": 3, "ongoing": true]
        XCTAssertEqual(
            ShannonLive2DMessage(body: ["type": "askReaction", "id": "a1", "occurredAt": "2026-10-03T03:00:00.000Z", "touch": asking]),
            .askReaction(.init(id: "a1", occurredAt: "2026-10-03T03:00:00.000Z", kind: .holdHand, durationMs: 2000, strength: 1, ongoing: true)))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "tap"]), .tap)
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "frameStats", "fps": 58]), .frameStats(fps: 58))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "error", "message": "WebGL2"]), .error("WebGL2"))
        XCTAssertEqual(
            ShannonLive2DMessage(body: ["type": "ready", "version": "0.1.0", "modelUpdatedAt": "m", "expressions": ["joyful", 3], "gestures": ["wave"]]),
            .ready(version: "0.1.0", modelUpdatedAt: "m", expressions: ["joyful"], gestures: ["wave"]))
        // Not in the contract's vocabulary, an id the server would refuse, or not an object at all: dropped.
        XCTAssertNil(ShannonLive2DMessage(body: ["type": "touch", "id": "x", "occurredAt": "t", "touch": ["type": "carry", "durationMs": 1]]))
        XCTAssertNil(ShannonLive2DMessage(body: ["type": "touch", "id": "bad id!", "occurredAt": "t", "touch": touch]))
        XCTAssertNil(ShannonLive2DMessage(body: ["type": "touch", "id": "x", "occurredAt": "t"]))
        XCTAssertNil(ShannonLive2DMessage(body: ["type": "navigate", "url": "https://example.com"]))
        XCTAssertNil(ShannonLive2DMessage(body: "ready"))
    }

    func testLayoutStaysInsideBounds() {
        let start = ShannonLive2DLayout(mode: .full)
        let bounds = CGSize(width: 400, height: 600)
        let moved = start.adjusted(scaleBy: 10, movedBy: CGSize(width: 900, height: -900), in: bounds)
        XCTAssertEqual(moved.scale, 3)
        XCTAssertEqual(moved.offsetX, 240)
        XCTAssertEqual(moved.offsetY, -360)
        XCTAssertEqual(start.adjusted(scaleBy: 0.01, movedBy: .zero, in: bounds).scale, 0.5)
        XCTAssertEqual(start.adjusted(scaleBy: .nan, movedBy: .zero, in: bounds), start)
        XCTAssertFalse(start.isMoved)
        XCTAssertTrue(moved.isMoved)
    }

    // MARK: The stage's rules

    func testThePageDrawsOnlyWhileSomeoneCanSeeIt() {
        typealias Policy = ShannonLive2DStagePolicy
        XCTAssertFalse(Policy.paused(hasHost: true, appActive: true, resting: false))
        XCTAssertTrue(Policy.paused(hasHost: false, appActive: true, resting: false))
        XCTAssertTrue(Policy.paused(hasHost: true, appActive: false, resting: false))
        XCTAssertTrue(Policy.paused(hasHost: true, appActive: true, resting: true))
        // Reduce Motion and Low Power Mode: an idle figure rests; one that listens, thinks or speaks does not.
        XCTAssertTrue(Policy.rests(calm: true, phase: .idle, idleSeconds: 5))
        XCTAssertFalse(Policy.rests(calm: true, phase: .idle, idleSeconds: 4.9))
        XCTAssertFalse(Policy.rests(calm: true, phase: .speaking, idleSeconds: 60))
        XCTAssertFalse(Policy.rests(calm: false, phase: .idle, idleSeconds: 60))
        // One automatic reload a minute.
        let now = Date()
        XCTAssertTrue(Policy.mayReload(lastReloadAt: nil, now: now))
        XCTAssertFalse(Policy.mayReload(lastReloadAt: now.addingTimeInterval(-59), now: now))
        XCTAssertTrue(Policy.mayReload(lastReloadAt: now.addingTimeInterval(-60), now: now))
        XCTAssertTrue(Policy.sendsMouthLevel(0.4, last: 0.2))
        XCTAssertFalse(Policy.sendsMouthLevel(0.41, last: 0.4))
        XCTAssertTrue(Policy.sendsMouthLevel(0, last: 0.4))
        XCTAssertFalse(Policy.sendsMouthLevel(0, last: 0))
    }

    // MARK: Driving

    func testPhaseDoingAndPresenceComeFromWhatTheAppAlreadyReads() {
        XCTAssertEqual(ShannonBodySignals.phase(isSendingText: true, call: nil), .thinking)
        XCTAssertEqual(ShannonBodySignals.phase(isSendingText: false, call: nil), .idle)
        XCTAssertEqual(ShannonBodySignals.phase(isSendingText: true, call: .listening), .listening)
        XCTAssertEqual(ShannonBodySignals.phase(isSendingText: false, call: .speaking), .speaking)
        XCTAssertEqual(ShannonBodySignals.phase(isSendingText: false, call: .waiting), .idle)
        XCTAssertEqual(ShannonLive2DPhase(.searching), .thinking)

        let now = ShannonBodySignals.date("2026-10-03T03:05:00.000Z")!
        func entry(_ id: String, _ tool: String?, _ at: String, kind: String = "action", actor: String = "shannon", outcome: String = "done") -> ShannonAutonomyActivityEntryDTO {
            ShannonAutonomyActivityEntryDTO(
                id: id, occurredAt: at, dayKey: "2026-10-03", kind: kind, actor: actor, summary: "", domain: "study", domainLabel: "",
                tool: tool, costYen: 0, outcome: outcome, approval: "not_needed")
        }
        func days(_ entries: ShannonAutonomyActivityEntryDTO...) -> [ShannonAutonomyActivityDayDTO] {
            [ShannonAutonomyActivityDayDTO(dayKey: "2026-10-03", summary: "", entries: entries)]
        }
        let drafting = days(entry("1", "study.read", "2026-10-03T03:01:00.000Z"), entry("2", "study.draft", "2026-10-03T03:04:00.000Z"))
        XCTAssertEqual(ShannonBodySignals.doing(loopState: "running", days: drafting, now: now), .drafting)
        XCTAssertEqual(ShannonBodySignals.doing(loopState: "paused", days: drafting, now: now), .idle)
        XCTAssertEqual(ShannonBodySignals.doing(loopState: nil, days: drafting, now: now), .idle)
        // Older than three minutes, the owner's own entries, a refused decision, and tools outside her study are not shown.
        XCTAssertEqual(ShannonBodySignals.doing(loopState: "running", days: days(entry("1", "study.draft", "2026-10-03T03:01:59.000Z")), now: now), .idle)
        XCTAssertEqual(ShannonBodySignals.doing(loopState: "running", days: days(entry("1", "study.draft", "2026-10-03T03:04:00.000Z", actor: "owner")), now: now), .idle)
        XCTAssertEqual(ShannonBodySignals.doing(loopState: "running", days: days(entry("1", "study.note", "2026-10-03T03:04:00.000Z", kind: "decision", outcome: "refused")), now: now), .idle)
        XCTAssertEqual(ShannonBodySignals.doing(loopState: "running", days: days(entry("1", "study.note", "2026-10-03T03:04:00.000Z", kind: "decision", outcome: "allowed")), now: now), .noting)
        XCTAssertEqual(ShannonBodySignals.doing(loopState: "running", days: days(entry("1", "body.look", "2026-10-03T03:04:00.000Z")), now: now), .idle)

        XCTAssertEqual(ShannonBodySignals.doingLine(phase: .thinking, doing: .drafting, awaitingReaction: 1), "返事を考えています")
        XCTAssertEqual(ShannonBodySignals.doingLine(phase: .idle, doing: .drafting, awaitingReaction: 1), "物語を書いています")
        XCTAssertEqual(ShannonBodySignals.doingLine(phase: .idle, doing: .idle, awaitingReaction: 1), "物語の感想を待っています")
        XCTAssertNil(ShannonBodySignals.doingLine(phase: .idle, doing: .idle, awaitingReaction: 0))

        let presence = ShannonBodySignals.presence(state: nil, doing: .reading, awaitingReaction: 2)
        XCTAssertEqual(presence, ShannonLive2DPresence(expression: nil, feeling: nil, intensity: 0, doing: "reading", awaitingReaction: 2))
    }

    func testMouthLevelIsTheDesktopRule() {
        XCTAssertEqual(ShannonSpeechLevelPublisher.mouthLevel(rms: 0.1), 0.5, accuracy: 0.0001)
        XCTAssertEqual(ShannonSpeechLevelPublisher.mouthLevel(rms: 0.4), 1)
        XCTAssertEqual(ShannonSpeechLevelPublisher.mouthLevel(rms: 0), 0)
        XCTAssertEqual(ShannonSpeechLevelPublisher.mouthLevel(rms: .nan), 0)
        let samples: [Float] = [0.5, -0.5, 0.5, -0.5, 0, 0, 0, 0, 1]
        let levels = samples.withUnsafeBufferPointer { ShannonSpeechLevelPublisher.windowedRMS($0, windowFrames: 4) }
        XCTAssertEqual(levels, [0.5, 0, 1])
    }

    func testSpeechLevelReachesTheSinkAndReturnsToZero() async {
        let publisher = ShannonSpeechLevelPublisher()
        let received = LevelBox()
        publisher.publish(rms: 0.125)
        publisher.setSink { received.values.append($0) }
        publisher.publish(rms: 0.125)
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(received.values, [0.625, 0])
        publisher.publish(rms: 0.2)
        publisher.end()
        publisher.setSink(nil)
        publisher.publish(rms: 0.2)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(received.values.last, 0)
        XCTAssertEqual(received.values.count, 4)
    }

    // MARK: Touch

    func testWithReportingOffATouchSendsNothing() async {
        let client = FakeBodyClient()
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { false }, capabilities: { ([], []) }, express: { _, _ in }))
        XCTAssertNil(coordinator.handle(.touch(Self.touch("t1"))))
        XCTAssertNil(coordinator.handle(.askReaction(Self.touch("t1", ongoing: true))))
        let calls = await client.calls
        XCTAssertEqual(calls, [])
        XCTAssertNil(coordinator.line)
    }

    func testADesignPreviewSendsNothing() async {
        let client = FakeBodyClient()
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, maySend: { false }, capabilities: { ([], []) }, express: { _, _ in }))
        XCTAssertNil(coordinator.handle(.touch(Self.touch("t1"))))
        XCTAssertNil(coordinator.handle(.askReaction(Self.touch("t1", ongoing: true))))
        let calls = await client.calls
        XCTAssertEqual(calls, [])
    }

    func testWithReportingOnItRegistersTouchOnlyAsksAndShowsHerLine() async {
        let client = FakeBodyClient()
        await client.setAnswer(.init(
            id: "t1", status: "said",
            message: .init(id: "m1", text: "えへへ、なんですかライ氏？", expression: "bashful", feeling: nil, threadId: nil, listenSeconds: 6),
            mood: .init(expression: "joyful", feeling: nil)))
        let shown = ExpressionBox()
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, audience: { .owner }, capabilities: { (["joyful", "だめ", "joyful"], ["wave"]) },
            express: { expression, _ in shown.values.append(expression) }))
        await coordinator.handle(.askReaction(Self.touch("t1", ongoing: true)))?.value
        await coordinator.handle(.touch(Self.touch("t1", durationMs: 2400)))?.value
        let calls = await client.calls
        XCTAssertEqual(calls, ["register", "ask:t1:owner:ongoing", "events:t1:owner:2400"])
        XCTAssertEqual(coordinator.line?.text, "えへへ、なんですかライ氏？")
        XCTAssertEqual(coordinator.line?.face, ShannonFace(expression: .bashful))
        XCTAssertEqual(shown.values, ["bashful"])
        XCTAssertEqual(coordinator.delivery, .fine)
        // Registration ids follow the server's rule; a name it would refuse is left out.
        XCTAssertEqual(ShannonBodyRegistration.identifiers(["joyful", "だめ", "joyful", "-x", "a.b_c-d"], limit: 64), ["joyful", "a.b_c-d"])
    }

    func testAQuietAnswerShowsHerFaceAndNoLine() async {
        let client = FakeBodyClient()
        await client.setAnswer(.init(id: "t1", status: "quiet", message: nil, mood: .init(expression: "bashful", feeling: "flustered")))
        let shown = ExpressionBox()
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, capabilities: { ([], []) }, express: { expression, feeling in shown.values.append("\(expression)/\(feeling ?? "-")") }))
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        XCTAssertNil(coordinator.line)
        XCTAssertEqual(shown.values, ["bashful/flustered"])
    }

    func testWithAFriendPresentTheTouchIsReportedAsSeenByOthers() async {
        let client = FakeBodyClient()
        let audience = AudienceBox()
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, audience: { audience.value }, capabilities: { ([], []) }, express: { _, _ in }))
        audience.value = .others
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        await coordinator.handle(.touch(Self.touch("t1")))?.value
        audience.value = .owner
        await coordinator.handle(.touch(Self.touch("t2")))?.value
        let calls = await client.calls
        XCTAssertEqual(calls, ["register", "ask:t1:others:ended", "events:t1:others:900", "events:t2:owner:900"])
    }

    func testAServerThatDoesNotKnowTheDeviceIsRegisteredAgainOnce() async {
        let client = FakeBodyClient()
        await client.failNextAsk(ShannonBodyRefusal(status: 403, code: "BODY_REACTION_NOT_A_BODY"))
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, capabilities: { ([], []) }, express: { _, _ in }))
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        let calls = await client.calls
        XCTAssertEqual(calls, ["register", "ask:t1:owner:ended", "register", "ask:t1:owner:ended"])
    }

    func testAFailedReportIsKeptAndSentWithTheNextTouchAndDroppedWhenSwitchedOff() async {
        let client = FakeBodyClient()
        let reports = FlagBox(true)
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { reports.value }, capabilities: { ([], []) }, express: { _, _ in }))
        await client.failNextEvents(URLError(.notConnectedToInternet))
        await coordinator.handle(.touch(Self.touch("t1")))?.value
        XCTAssertEqual(coordinator.delivery, .failed)
        await coordinator.handle(.touch(Self.touch("t2")))?.value
        XCTAssertEqual(coordinator.delivery, .fine)
        await client.failNextEvents(ShannonBodyRefusal(status: 401))
        await coordinator.handle(.touch(Self.touch("t3")))?.value
        XCTAssertEqual(coordinator.delivery, .notConnected)
        reports.value = false
        coordinator.reportingChanged()
        XCTAssertEqual(coordinator.delivery, .fine)
        reports.value = true
        await coordinator.handle(.touch(Self.touch("t4")))?.value
        let calls = await client.calls
        XCTAssertEqual(calls, ["register", "events:t1:owner:900", "events:t1:owner:900,t2:owner:900", "events:t3:owner:900", "events:t4:owner:900"])
    }

    func testAnOlderServerIsSaidToBeUnsupported() async {
        let client = FakeBodyClient()
        await client.failNextEvents(ShannonBodyRefusal(status: 403, code: "BODY_INGEST_DISABLED"))
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, capabilities: { ([], []) }, express: { _, _ in }))
        await coordinator.handle(.touch(Self.touch("t1")))?.value
        XCTAssertEqual(coordinator.delivery, .unsupported)
    }

    func testRequestsCarryOnlyTheContractsFields() throws {
        let touch = Self.touch("t1", ongoing: true)
        let reaction = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ShannonBodyReactionRequestDTO(scopeKey: "owner", touch: touch, audience: .others))) as? [String: Any]
        XCTAssertEqual(Set(reaction?.keys ?? [:].keys), ["scopeKey", "id", "touch", "audience", "occurredAt"])
        XCTAssertEqual(Set((reaction?["touch"] as? [String: Any])?.keys ?? [:].keys), ["type", "durationMs", "strength", "ongoing"])
        XCTAssertEqual(reaction?["audience"] as? String, "others")
        let event = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ShannonBodyTouchEventDTO(touch: touch, audience: .owner))) as? [String: Any]
        XCTAssertEqual(Set(event?.keys ?? [:].keys), ["id", "type", "audience", "occurredAt", "durationMs", "strength"])
    }

    func testAStudyCardSaysWhetherItAwaitsAReaction() throws {
        let json = #"{"id":"p1","kind":"story","kindLabel":"物語","status":"shown","statusLabel":"見せた","hidden":false,"revising":false,"updatedAt":"2026-10-03T00:00:00.000Z","awaitingReaction":true}"#
        XCTAssertEqual(try JSONDecoder().decode(ShannonStudyPieceCardDTO.self, from: Data(json.utf8)).awaitingReaction, true)
        let older = #"{"id":"p1","kind":"story","kindLabel":"物語","status":"shown","statusLabel":"見せた","hidden":false,"revising":false,"updatedAt":"2026-10-03T00:00:00.000Z"}"#
        XCTAssertNil(try JSONDecoder().decode(ShannonStudyPieceCardDTO.self, from: Data(older.utf8)).awaitingReaction)
    }

    private static func touch(_ id: String, durationMs: Int = 900, ongoing: Bool = false) -> ShannonLive2DTouch {
        ShannonLive2DTouch(id: id, occurredAt: "2026-10-03T03:00:00.000Z", kind: .pet, durationMs: durationMs, strength: 0.4, ongoing: ongoing)
    }
}

@MainActor private final class LevelBox: Sendable { var values: [Double] = [] }
@MainActor private final class ExpressionBox: Sendable { var values: [String] = [] }
@MainActor private final class AudienceBox: Sendable { var value = ShannonBodyAudience.owner }
@MainActor private final class FlagBox: Sendable {
    var value: Bool
    init(_ value: Bool) { self.value = value }
}

private actor FakeBodyClient: ShannonBodyServing {
    private(set) var calls: [String] = []
    private var answer = ShannonBodyReactionAnswerDTO(id: "", status: "quiet")
    private var askFailure: (any Error)?
    private var eventsFailure: (any Error)?

    func setAnswer(_ value: ShannonBodyReactionAnswerDTO) { answer = value }
    func failNextAsk(_ error: any Error) { askFailure = error }
    func failNextEvents(_ error: any Error) { eventsFailure = error }

    func registerTouchBody(scopeKey: String, expressions: [String], gestures: [String]) async throws {
        calls.append("register")
    }

    func sendBodyTouches(scopeKey: String, events: [ShannonBodyTouchEventDTO]) async throws {
        calls.append("events:" + events.map { "\($0.id):\($0.audience.rawValue):\($0.durationMs)" }.joined(separator: ","))
        if let error = eventsFailure {
            eventsFailure = nil
            throw error
        }
    }

    func askBodyReaction(_ request: ShannonBodyReactionRequestDTO) async throws -> ShannonBodyReactionAnswerDTO {
        calls.append("ask:\(request.id):\(request.audience.rawValue):\(request.touch.ongoing ? "ongoing" : "ended")")
        if let error = askFailure {
            askFailure = nil
            throw error
        }
        return answer
    }
}
