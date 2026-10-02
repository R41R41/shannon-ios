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
        XCTAssertEqual(version?["modelUpdatedAt"] as? String, "2026-10-02T19:15:02.996Z")
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
            #"window.shannonBody&&window.shannonBody.setLayout({mode:"full",scale:1.500,offsetX:-12.000,offsetY:30.000,fit:null});"#)
        XCTAssertEqual(
            ShannonLive2DCommand.setLayout(.init(mode: .bust, contained: true)).javaScript,
            #"window.shannonBody&&window.shannonBody.setLayout({mode:"bust",scale:1.000,offsetX:0.000,offsetY:0.000,fit:"contain"});"#)
        // Calls an older page does not have are asked for only when they are there.
        XCTAssertEqual(
            ShannonLive2DCommand.setIdle(gestures: false, sway: 0).javaScript,
            "window.shannonBody&&typeof window.shannonBody.setIdle==='function'&&window.shannonBody.setIdle({gestures:false,sway:0.000});")
        XCTAssertEqual(
            ShannonLive2DCommand.setFrameRate(30).javaScript,
            "window.shannonBody&&typeof window.shannonBody.setFrameRate==='function'&&window.shannonBody.setFrameRate(30);")
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
        // The newer page: progress while loading, a lost drawing surface it mends itself, and the touched part.
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "loading", "progress": 0.4]), .loading(progress: 0.4))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "loading", "progress": 7]), .loading(progress: 1))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "contextLost"]), .contextLost)
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "contextRestored", "attempts": 2]), .contextRestored)
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "error", "code": "contextLost", "message": "x"]), .error("x", code: "contextLost"))
        let poked: [String: Any] = ["type": "poke", "durationMs": 0, "strength": 0, "ongoing": false, "region": "face"]
        XCTAssertEqual(
            ShannonLive2DMessage(body: ["type": "touch", "id": "p1", "occurredAt": "t", "touch": poked]),
            .touch(.init(id: "p1", occurredAt: "t", kind: .poke, durationMs: 0, strength: 0, ongoing: false, region: .face)))
        let unknownPart: [String: Any] = ["type": "poke", "durationMs": 0, "region": "ear"]
        XCTAssertEqual(
            ShannonLive2DMessage(body: ["type": "touch", "id": "p2", "occurredAt": "t", "touch": unknownPart]),
            .touch(.init(id: "p2", occurredAt: "t", kind: .poke, durationMs: 0, strength: 0, ongoing: false)))
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

    func testTheOfflineRulesCompileAndNameEachScheme() async throws {
        // The pattern language of content rules has no alternation; one rule per scheme.
        XCTAssertFalse(ShannonLive2DBridge.offlineRules.contains("|"))
        let rules = try JSONSerialization.jsonObject(with: Data(ShannonLive2DBridge.offlineRules.utf8)) as? [[String: Any]]
        let filters = rules?.compactMap { ($0["trigger"] as? [String: Any])?["url-filter"] as? String }
        XCTAssertEqual(filters, ["^https?:", "^wss?:", "^ftp:"])
        XCTAssertEqual(rules?.compactMap { ($0["action"] as? [String: Any])?["type"] as? String }, ["block", "block", "block"])
        // WebKit itself must accept them: the page is not loaded otherwise.
        _ = try await ShannonLive2DBridge.offlineRuleList()
    }

    func testACancelledNavigationIsNotABrokenPage() {
        XCTAssertTrue(ShannonLive2DBridge.isCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        XCTAssertTrue(ShannonLive2DBridge.isCancellation(NSError(domain: "WebKitErrorDomain", code: 102)))
        XCTAssertFalse(ShannonLive2DBridge.isCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)))
    }

    func testAPinchAndDragStayWhereTheFingersLeftThem() {
        var tracker = ShannonLive2DGestureTracker()
        var layout = ShannonLive2DLayout(mode: .full)
        let bounds = CGSize(width: 400, height: 600)
        tracker.beginPinch()
        tracker.beginPan()
        for (scale, x) in [(1.2, 10.0), (1.5, 30.0), (2.0, 40.0)] {
            layout = layout.adjusted(scaleBy: tracker.pinch(scale: scale), movedBy: .zero, in: bounds)
            layout = layout.adjusted(scaleBy: 1, movedBy: tracker.pan(translation: CGSize(width: x, height: 0)), in: bounds)
        }
        // The pinch ends first; the drag goes on. Nothing snaps back.
        layout = layout.adjusted(scaleBy: 1, movedBy: tracker.pan(translation: CGSize(width: 60, height: -20)), in: bounds)
        XCTAssertEqual(layout.scale, 2, accuracy: 0.0001)
        XCTAssertEqual(layout.offsetX, 60, accuracy: 0.0001)
        XCTAssertEqual(layout.offsetY, -20, accuracy: 0.0001)
        // A second gesture starts from where the first one ended.
        tracker.beginPinch()
        tracker.beginPan()
        layout = layout.adjusted(scaleBy: tracker.pinch(scale: 0.5), movedBy: tracker.pan(translation: CGSize(width: -10, height: 0)), in: bounds)
        XCTAssertEqual(layout.scale, 1, accuracy: 0.0001)
        XCTAssertEqual(layout.offsetX, 50, accuracy: 0.0001)
        XCTAssertEqual(tracker.pinch(scale: .nan), 1)
    }

    func testOthersStayTheAudienceForAWhileAfterAFriendWasListening() {
        var rule = ShannonBodyAudienceRule()
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(rule.audience(at: start), .owner)
        rule.observe(othersMayBeListening: true, at: start)
        XCTAssertEqual(rule.audience(at: start.addingTimeInterval(3_600)), .others)
        // The call returns to the owner alone, or ends: the friend is still in the room.
        rule.observe(othersMayBeListening: false, at: start.addingTimeInterval(3_600))
        XCTAssertEqual(rule.audience(at: start.addingTimeInterval(3_600 + 299)), .others)
        XCTAssertEqual(rule.audience(at: start.addingTimeInterval(3_600 + 300)), .owner)
        // Observing "nobody" again does not extend the hold.
        rule.observe(othersMayBeListening: false, at: start.addingTimeInterval(3_600 + 200))
        XCTAssertEqual(rule.audience(at: start.addingTimeInterval(3_600 + 300)), .owner)
        XCTAssertEqual(ShannonBodyAudienceRule.holdSeconds, 300)
        // The hold survives a relaunch, also one in the middle of the call.
        let defaults = UserDefaults(suiteName: "shannon-body-audience-\(UUID().uuidString)")!
        XCTAssertEqual(ShannonBodyAudienceRule(defaults: defaults).audience(at: start), .owner)
        var running = ShannonBodyAudienceRule()
        running.observe(othersMayBeListening: true, at: start)
        running.save(to: defaults)
        let relaunched = ShannonBodyAudienceRule(defaults: defaults)
        XCTAssertEqual(relaunched.audience(at: start.addingTimeInterval(299)), .others)
        XCTAssertEqual(relaunched.audience(at: start.addingTimeInterval(300)), .owner)
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
        // A finger on her is not idleness.
        XCTAssertFalse(Policy.rests(calm: true, phase: .idle, idleSeconds: 60, fingerDown: true))
        // A page that never became ready is reloaded once, not for ever.
        XCTAssertTrue(Policy.mayReload(lastReloadAt: nil, now: now, failuresWithoutReady: 1))
        XCTAssertFalse(Policy.mayReload(lastReloadAt: nil, now: now, failuresWithoutReady: 2))
        // Loading: a page that reports progress is given its time; a silent one is not.
        XCTAssertFalse(Policy.loadTimedOut(waited: 60, silent: 39))
        XCTAssertTrue(Policy.loadTimedOut(waited: 45, silent: 40))
        // A page that calms itself rests only in Low Power Mode, and after a minute; one that cannot, after five seconds.
        XCTAssertFalse(Policy.mayRest(reduceMotion: true, lowPower: false, calmsInPage: true))
        XCTAssertTrue(Policy.mayRest(reduceMotion: true, lowPower: true, calmsInPage: true))
        XCTAssertTrue(Policy.mayRest(reduceMotion: true, lowPower: false, calmsInPage: false))
        XCTAssertFalse(Policy.mayRest(reduceMotion: false, lowPower: false, calmsInPage: false))
        XCTAssertFalse(Policy.rests(calm: true, phase: .idle, idleSeconds: 59, calmsInPage: true))
        XCTAssertTrue(Policy.rests(calm: true, phase: .idle, idleSeconds: 60, calmsInPage: true))
        XCTAssertTrue(Policy.loadTimedOut(waited: 90, silent: 0))
        XCTAssertEqual(Policy.frameRate(lowPower: true), 30)
        XCTAssertEqual(Policy.frameRate(lowPower: false), 0)
        // The screen that shows her: the highest priority, and among equals the one that came last.
        XCTAssertEqual(Policy.insertionIndex(for: .bodyScreen, among: [.dialogue]), 1)
        XCTAssertEqual(Policy.insertionIndex(for: .dialogue, among: [.bodyScreen]), 0)
        XCTAssertEqual(Policy.insertionIndex(for: .hero, among: [.hero, .dialogue, .voice]), 1)
        XCTAssertEqual(Policy.insertionIndex(for: .voice, among: [.hero, .voice, .bodyScreen]), 2)
        XCTAssertEqual(Policy.insertionIndex(for: .dialogue, among: []), 0)
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

    func testATouchThatArrivesDuringASendIsSentRightAfterIt() async {
        let client = FakeBodyClient()
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, capabilities: { ([], []) }, express: { _, _ in }))
        await client.holdEvents()
        let first = coordinator.handle(.touch(Self.touch("t1")))
        while await client.calls.count < 2 { await Task.yield() }
        // The first batch is on its way; a second touch comes in and its own flush finds one already running.
        await coordinator.handle(.touch(Self.touch("t2")))?.value
        await client.releaseEvents()
        await first?.value
        let calls = await client.calls
        XCTAssertEqual(calls, ["register", "events:t1:owner:900", "events:t2:owner:900"])
    }

    func testSwitchingOffWhileRegisteringSendsNothing() async {
        let client = FakeBodyClient()
        let reports = FlagBox(true)
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { reports.value }, capabilities: { ([], []) }, express: { _, _ in }))
        await client.onRegister { await MainActor.run { reports.value = false } }
        await coordinator.handle(.touch(Self.touch("t1")))?.value
        reports.value = true
        await client.onRegister { await MainActor.run { reports.value = false } }
        // Registered already, so the next ask goes out; switch off before a fresh coordinator's ask instead.
        let second = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { reports.value }, capabilities: { ([], []) }, express: { _, _ in }))
        await second.handle(.askReaction(Self.touch("t2")))?.value
        let calls = await client.calls
        XCTAssertEqual(calls, ["register", "register"])
        XCTAssertNil(second.line)
    }

    // MARK: Her voice for a touch

    func testAReactionIsTextUnlessTheSurfaceAnswersInVoice() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-body-voice-\(UUID().uuidString)"))
        XCTAssertEqual(ShannonBodyReplyMode.current(defaults: defaults), .text)
        defaults.set("voice", forKey: ShannonBodyReplyMode.storageKey)
        XCTAssertEqual(ShannonBodyReplyMode.current(defaults: defaults), .voice)
        XCTAssertEqual(ShannonBodyReplyMode.allCases.map(\.japaneseName), ["文字で返す", "声で返す"])

        let client = FakeBodyClient()
        await client.setAnswer(.init(
            id: "t1", status: "said",
            message: .init(id: "m1", text: "えへへ、なんですかライ氏？", expression: "bashful", feeling: nil, threadId: "thread-9", listenSeconds: 6),
            mood: nil))
        let spoken = LineBox()
        let voiceMode = FlagBox(false)
        var environment = ShannonBodyTouchCoordinator.Environment(reportsTouch: { true }, capabilities: { ([], []) }, express: { _, _ in })
        environment.repliesInVoice = { voiceMode.value }
        environment.speak = { line in spoken.values.append(line) }
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: environment)
        // Text mode: the bubble only.
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        XCTAssertEqual(coordinator.line?.text, "えへへ、なんですかライ氏？")
        XCTAssertEqual(spoken.values.count, 0)
        XCTAssertFalse(coordinator.isSpeaking)
        // Voice mode: the bubble, and the line handed to her voice with what the answer needs.
        voiceMode.value = true
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        for _ in 0..<50 where coordinator.isSpeaking { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(spoken.values.map(\.reactionID), ["t1"])
        XCTAssertEqual(spoken.values.first?.threadID, "thread-9")
        XCTAssertEqual(spoken.values.first?.listenSeconds, 6)
        XCTAssertFalse(coordinator.isSpeaking)
    }

    func testTheFirstUtteranceAfterASpokenLineNamesTheReactionAndNoOtherDoes() throws {
        let link = ShannonBodyReactionLink()
        let now = Date(timeIntervalSince1970: 10_000)
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "なに？", now: now))
        link.arm(reactionID: "t1", listenSeconds: 6, now: now)
        // A turn other people can hear never carries it.
        XCTAssertNil(link.forDelegation(ownerMode: false, utterance: "なに？", now: now))
        XCTAssertNil(link.forTurn(companionPresent: false, now: now))
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(60)), "t1")
        // A retry or a fallback of the same utterance keeps it; the next utterance does not get it.
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(200)), "t1")
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "それでね", now: now.addingTimeInterval(61)))
        XCTAssertEqual(link.forTurn(companionPresent: false, now: now.addingTimeInterval(120)), "t1")
        XCTAssertNil(link.forTurn(companionPresent: false, now: now.addingTimeInterval(121)))
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(122)))
        // Too late for the server's window: an ordinary turn.
        link.arm(reactionID: "t2", listenSeconds: 6, now: now)
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(67)))
        // A companion turned up between the delegation and the stored turn: the turn is stored without it.
        link.arm(reactionID: "t3", listenSeconds: 6, now: now)
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now), "t3")
        XCTAssertNil(link.forTurn(companionPresent: true, now: now))
        // The stored turn comes later than the server keeps the link: stored without it.
        link.arm(reactionID: "t4", listenSeconds: 6, now: now)
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now), "t4")
        XCTAssertNil(link.forTurn(companionPresent: false, now: now.addingTimeInterval(601)))
        // The call ended before he said anything: a later call never gets the id.
        link.arm(reactionID: "t5", listenSeconds: 6, now: now)
        link.disarm()
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "なに？", now: now))

        // On the wire: present only on the utterance it belongs to.
        link.arm(reactionID: "t6", listenSeconds: 6)
        let request = ShannonLiveVoiceDelegationRequestDTO(scopeKey: "owner", threadId: "th", transcript: "なに？", participantMode: .owner)
        let other = ShannonLiveVoiceDelegationRequestDTO(scopeKey: "owner", threadId: "th", transcript: "それでね", participantMode: .owner)
        func sent(_ value: ShannonLiveVoiceDelegationRequestDTO) throws -> String? {
            (try JSONSerialization.jsonObject(with: JSONEncoder().encode(value.linkedToReaction(link))) as? [String: Any])?["reactionId"] as? String
        }
        XCTAssertEqual(try sent(request), "t6")
        XCTAssertEqual(try sent(request), "t6")
        XCTAssertNil(try sent(other))
        let turn = ShannonRealtimeVoiceTurnRequestDTO(scopeKey: "owner", threadId: "th", userTranscript: "なに？", shannonTranscript: "えへへ")
        let stored = try JSONSerialization.jsonObject(with: JSONEncoder().encode(turn.linkedToReaction(link))) as? [String: Any]
        XCTAssertEqual(stored?["reactionId"] as? String, "t6")
    }

    func testHerVoiceForATouchYieldsToEverythingElseAndStopsWhenTheSurfaceNoLongerAnswersInVoice() async {
        let arbiter = ShannonSpeechArbiter()
        let speaker = FakeLineSpeaker()
        let voice = ShannonBodyVoice(speaker: speaker, arbiter: arbiter)
        let allowed = FlagBox(true)
        let heard = LineBox()
        voice.mayAnswerInVoice = { allowed.value }
        voice.listen = { line, _ in heard.values.append(line) }
        func line(_ audience: ShannonBodyAudience = .owner, listen: Int = 6) -> ShannonBodyTouchCoordinator.Line {
            .init(id: "m", text: "えへへ", face: nil, reactionID: "t", threadID: nil, listenSeconds: listen, audience: audience)
        }
        // A call, dictation or a ringing call of hers; one of her own messages being said; another touch line.
        let session = FlagBox(true)
        arbiter.sessionInUse = { session.value }
        XCTAssertFalse(voice.canSpeakNow)
        await voice.say(line())
        session.value = false
        let reachOut = FlagBox(true)
        arbiter.reachOutIsSpeaking = { reachOut.value }
        await voice.say(line())
        reachOut.value = false
        arbiter.touchLineIsActive = true
        await voice.say(line())
        arbiter.touchLineIsActive = false
        // Other people around: never aloud, never listened for.
        await voice.say(line(.others))
        // The surface does not answer in voice (the screen was left, 文字で返す, 伝える off, the app in the background).
        allowed.value = false
        await voice.say(line())
        XCTAssertEqual(speaker.spoken, [])
        XCTAssertEqual(heard.values.count, 0)

        // Free: she speaks, the arbiter knows it while she does, and then he may answer.
        allowed.value = true
        XCTAssertTrue(voice.canSpeakNow)
        speaker.during = {
            XCTAssertTrue(arbiter.touchLineIsActive)
            XCTAssertTrue(arbiter.touchLineHoldsSound)
        }
        await voice.say(line())
        XCTAssertEqual(speaker.spoken, ["えへへ"])
        XCTAssertEqual(heard.values.count, 1)
        XCTAssertFalse(arbiter.touchLineIsActive)
        XCTAssertEqual(speaker.lastStillPrivate, true)

        // He starts a call while the voice is being fetched: the speaker is told no, and nothing is listened for.
        speaker.during = { session.value = true }
        speaker.outcome = .notStarted
        await voice.say(line())
        XCTAssertEqual(speaker.lastStillPrivate, false)
        XCTAssertEqual(heard.values.count, 1)
        session.value = false
        // He leaves the screen while she speaks: cut short, and no microphone.
        speaker.during = { allowed.value = false }
        speaker.outcome = .cutShort
        await voice.say(line())
        XCTAssertEqual(speaker.lastStillPrivate, false)
        XCTAssertEqual(heard.values.count, 1)
        allowed.value = true
        // A line that came too late (the speaker's first-sound limit) is the bubble only.
        speaker.during = nil
        speaker.outcome = .notStarted
        await voice.say(line())
        XCTAssertEqual(heard.values.count, 1)
        XCTAssertEqual(ShannonBodyVoice.firstSoundSeconds, 6)
        voice.stop()
        XCTAssertEqual(speaker.stops, 1)
    }

    func testALineSaidWithOthersAroundIsNeverSpokenAndASpokenLineIsMarked() async {
        let client = FakeBodyClient()
        await client.setAnswer(.init(
            id: "t1", status: "said",
            message: .init(id: "m1", text: "えへへ", expression: "bashful", feeling: nil, threadId: nil, listenSeconds: 6), mood: nil))
        let spoken = LineBox()
        let audience = AudienceBox()
        var environment = ShannonBodyTouchCoordinator.Environment(
            reportsTouch: { true }, audience: { audience.value }, capabilities: { ([], []) }, express: { _, _ in })
        environment.repliesInVoice = { true }
        environment.speak = { line in spoken.values.append(line) }
        let stopped = FlagBox(false)
        environment.stopSpeaking = { stopped.value = true }
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: environment)
        audience.value = .others
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        XCTAssertEqual(coordinator.line?.audience, .others)
        XCTAssertEqual(coordinator.line?.isSpoken, false)
        XCTAssertEqual(spoken.values.count, 0)
        audience.value = .owner
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        for _ in 0..<50 where coordinator.isSpeaking { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(coordinator.line?.isSpoken, true)
        XCTAssertEqual(spoken.values.map(\.audience), [.owner])
        // Switching the reporting off stops her voice.
        coordinator.environment.reportsTouch = { false }
        coordinator.reportingChanged()
        XCTAssertTrue(stopped.value)
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
        // A pet is on the head even when the page did not say so.
        XCTAssertEqual(Set((reaction?["touch"] as? [String: Any])?.keys ?? [:].keys), ["type", "durationMs", "strength", "ongoing", "region"])
        XCTAssertEqual((reaction?["touch"] as? [String: Any])?["region"] as? String, "head")
        XCTAssertEqual(reaction?["audience"] as? String, "others")
        let event = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ShannonBodyTouchEventDTO(touch: touch, audience: .owner))) as? [String: Any]
        XCTAssertEqual(Set(event?.keys ?? [:].keys), ["id", "type", "audience", "occurredAt", "durationMs", "strength", "region"])
        // The part: the page's own when it says one; otherwise only what the gesture leaves no doubt about.
        func part(_ kind: ShannonLive2DTouch.Kind, _ region: ShannonLive2DTouch.Region? = nil) -> String? {
            ShannonLive2DTouch(id: "x", occurredAt: "t", kind: kind, durationMs: 0, strength: 0, ongoing: false, region: region).sentRegion?.rawValue
        }
        XCTAssertEqual([part(.pet), part(.holdHand), part(.tickle), part(.poke)], ["head", "hand", "side", nil])
        XCTAssertEqual([part(.poke, .face), part(.poke, .side), part(.pet, .body)], ["face", "side", "body"])
        let poke = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ShannonBodyTouchEventDTO(
            touch: .init(id: "x", occurredAt: "t", kind: .poke, durationMs: 0, strength: 0, ongoing: false), audience: .owner))) as? [String: Any]
        XCTAssertNil(poke?["region"])
        XCTAssertTrue(["iphone", "mac"].contains(ShannonBodyRegistration.surface))
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

@MainActor
private final class FakeLineSpeaker: ShannonReachOutSpeaking {
    var spoken: [String] = []
    var outcome = ShannonReachOutSpeechOutcome.spoken
    /// What happens between the request for her voice and its first sound.
    var during: (@MainActor () -> Void)?
    var lastStillPrivate: Bool?
    var stops = 0

    func speak(_ text: String, stillPrivate: @escaping @MainActor () -> Bool) async -> ShannonReachOutSpeechOutcome {
        during?()
        lastStillPrivate = stillPrivate()
        if outcome == .spoken { spoken.append(text) }
        return outcome
    }

    func stop() { stops += 1 }
}
@MainActor private final class LineBox: Sendable { var values: [ShannonBodyTouchCoordinator.Line] = [] }
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

    private var registerHook: (@Sendable () async -> Void)?
    private var eventsHeld = false
    private var eventsWaiters: [CheckedContinuation<Void, Never>] = []

    func onRegister(_ hook: @escaping @Sendable () async -> Void) { registerHook = hook }
    func holdEvents() { eventsHeld = true }
    func releaseEvents() {
        eventsHeld = false
        eventsWaiters.forEach { $0.resume() }
        eventsWaiters = []
    }

    func setAnswer(_ value: ShannonBodyReactionAnswerDTO) { answer = value }
    func failNextAsk(_ error: any Error) { askFailure = error }
    func failNextEvents(_ error: any Error) { eventsFailure = error }

    func registerTouchBody(scopeKey: String, expressions: [String], gestures: [String]) async throws {
        calls.append("register")
        if let hook = registerHook {
            registerHook = nil
            await hook()
        }
    }

    func sendBodyTouches(scopeKey: String, events: [ShannonBodyTouchEventDTO]) async throws {
        calls.append("events:" + events.map { "\($0.id):\($0.audience.rawValue):\($0.durationMs)" }.joined(separator: ","))
        if eventsHeld { await withCheckedContinuation { eventsWaiters.append($0) } }
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
