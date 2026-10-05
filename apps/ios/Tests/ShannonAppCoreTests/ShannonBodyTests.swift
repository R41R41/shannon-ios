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

    func testTheBodyDefaultsToTheCharacterAndHerEyesAloneAreChosenPerDevice() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-body-tests-\(UUID().uuidString)"))
        XCTAssertEqual(ShannonLive2DBody.current(defaults: defaults), .human)
        defaults.set(ShannonLive2DBody.eyes.rawValue, forKey: ShannonLive2DBody.storageKey)
        XCTAssertEqual(ShannonLive2DBody.current(defaults: defaults), .eyes)
        defaults.set("tail", forKey: ShannonLive2DBody.storageKey)
        XCTAssertEqual(ShannonLive2DBody.current(defaults: defaults), .human)
        // The desktop's words (設定 › すがた › 体); on the iPhone the eyes are said to move as the Waterlight Eye does.
        XCTAssertEqual(ShannonBodyCopy.bodyTitle, "体")
        XCTAssertEqual(ShannonLive2DBody.allCases.map(\.japaneseName), ["人の姿", "目だけ"])
        XCTAssertNil(ShannonLive2DBody.human.explanation)
        XCTAssertEqual(
            ShannonLive2DBody.eyes.explanation,
            "水色の目が 2 つだけのシャノンです（水の光の目と同じ動き）。表情と、聞いている・考えている・話しているは、目の形と動きで伝えます。")
        XCTAssertTrue(ShannonLive2DBody.human.hasCharacterRig)
        XCTAssertFalse(ShannonLive2DBody.eyes.hasCharacterRig)
        // Her eyes alone are only poked: the settings do not offer stroking, tickling or holding hands there.
        XCTAssertEqual(ShannonBodyCopy.settingsExplanation(body: .human), ShannonBodyCopy.settingsExplanation)
        XCTAssertEqual(
            ShannonBodyCopy.settingsExplanation(body: .eyes),
            "目だけのときは、目のあたりを軽くつつけます（なでる・くすぐる・手をつなぐは、ありません）。"
                + "「体に起きたことをシャノンに伝える」がオフの間は、この端末の中で動くだけで、何も送りません。"
                + "オンにすると、触れた種類・長さ・強さ・時刻だけがシャノンに届き、気持ちが動いて、ひとこと返すことがあります。カメラは使いません。")
    }

    // MARK: Her body (the character or her eyes alone)

    private typealias BodySwitch = ShannonLive2DBodySwitch
    private static let bothBodies: [ShannonLive2DBody] = [.human, .eyes]

    /// The page is ready, showing `shown`, with `chosen` chosen and nothing asked yet.
    private static func readySwitch(chosen: ShannonLive2DBody, shown: ShannonLive2DBody) -> BodySwitch {
        var machine = BodySwitch(chosen: chosen, offered: bothBodies)
        _ = machine.reduce(.ready(bodies: bothBodies, shown: shown))
        return machine
    }

    func testOnlyOneBodySwitchIsUnderWayAtATimeAndTheLatestChoiceIsAskedOnceAfterIt() {
        var machine = BodySwitch(chosen: .human, offered: Self.bothBodies)
        // Nothing is asked of a page that is not ready.
        XCTAssertEqual(machine.reduce(.chose(.eyes)), [])
        // Ready in the character (the choice came while it loaded): her eyes are asked for.
        XCTAssertEqual(machine.reduce(.ready(bodies: Self.bothBodies, shown: .human)), [.request(.eyes)])
        XCTAssertEqual(machine.pending, .eyes)
        // While that switch is under way, every further choice (or every figure asking again) sends nothing.
        XCTAssertEqual(machine.reduce(.chose(.human)), [])
        XCTAssertEqual(machine.reduce(.chose(.eyes)), [])
        XCTAssertEqual(machine.reduce(.chose(.human)), [])
        XCTAssertEqual(machine.pending, .eyes)
        // The page says it shows her eyes: what is said after a switch, then the latest choice, asked once.
        XCTAssertEqual(machine.reduce(.switched(.eyes)), [.afterSwitch(.eyes), .request(.human)])
        XCTAssertEqual(machine.pending, .human)
        XCTAssertEqual(machine.reduce(.switched(.human)), [.afterSwitch(.human)])
        XCTAssertNil(machine.pending)
        XCTAssertEqual(machine.shown, .human)
        // The body shown is not asked for again.
        XCTAssertEqual(machine.reduce(.chose(.human)), [])
    }

    func testReadySaysWhichBodiesThePageHasAndWhichItShows() {
        // Started in her eyes (`?body=eyes`): nothing to ask.
        var started = BodySwitch(chosen: .eyes, offered: Self.bothBodies)
        XCTAssertEqual(started.reduce(.ready(bodies: Self.bothBodies, shown: .eyes)), [])
        XCTAssertEqual(started.shown, .eyes)
        // An older page names no bodies and no body: the character only, and the eyes are never asked for.
        var older = BodySwitch(chosen: .eyes, offered: Self.bothBodies)
        XCTAssertEqual(older.reduce(.ready(bodies: [], shown: nil)), [])
        XCTAssertEqual(older.offered, [.human])
        XCTAssertEqual(older.target, .human)
        XCTAssertEqual(older.reduce(.chose(.eyes)), [])
        XCTAssertEqual(ShannonLive2DBodyPolicy.effective(.eyes, offered: [.human]), .human)
        // Before it is loaded, the bundled page's bodies come from its file list.
        XCTAssertEqual(ShannonLive2DBodyPolicy.bundled(files: ["model/Shannon.moc3", "model-eyes/Shannon_Eyes_v2.moc3"]), [.human, .eyes])
        XCTAssertEqual(ShannonLive2DBodyPolicy.bundled(files: ["model/Shannon.moc3"]), [.human])
        XCTAssertEqual(ShannonLive2DStage.bundledBodies, [.human, .eyes])
    }

    func testAReleaseWhileASwitchIsPendingForgetsItAndTheNextPageStartsInTheChoice() {
        var machine = Self.readySwitch(chosen: .human, shown: .human)
        XCTAssertEqual(machine.reduce(.chose(.eyes)), [.request(.eyes)])
        // No screen shows her for 90 seconds, or a memory warning: the web view goes.
        XCTAssertEqual(machine.reduce(.released(bundled: Self.bothBodies)), [])
        XCTAssertNil(machine.pending)
        XCTAssertEqual(machine.chosen, .eyes)
        XCTAssertEqual(machine.reduce(.foregroundSecond), [])
        // The next page is started in her eyes and says so: nothing is left to ask.
        XCTAssertEqual(machine.reduce(.ready(bodies: Self.bothBodies, shown: .eyes)), [])
        XCTAssertNil(machine.pending)
    }

    func testAnErrorWhileASwitchIsPendingEndsItAndTheReloadedPageIsAskedAgainIfNeeded() {
        var machine = Self.readySwitch(chosen: .human, shown: .human)
        XCTAssertEqual(machine.reduce(.chose(.eyes)), [.request(.eyes)])
        // The page reports `error`: the stage's recover() releases the web view before it reloads.
        XCTAssertEqual(machine.reduce(.released(bundled: Self.bothBodies)), [])
        XCTAssertNil(machine.pending)
        // A reloaded page that comes up in the character after all is asked for her eyes once.
        XCTAssertEqual(machine.reduce(.ready(bodies: Self.bothBodies, shown: .human)), [.request(.eyes)])
    }

    func testWhileTheSurfaceIsLostChoicesAreHeldAndTheBodyIsAskedAgainWhenItIsBack() {
        // The race: her eyes were switched to, then the page's mending brings back the character.
        var machine = Self.readySwitch(chosen: .human, shown: .human)
        XCTAssertEqual(machine.reduce(.chose(.eyes)), [.request(.eyes)])
        XCTAssertEqual(machine.reduce(.switched(.eyes)), [.afterSwitch(.eyes)])
        XCTAssertEqual(machine.reduce(.contextLost), [])
        // Held while the surface is lost; no time counts.
        XCTAssertEqual(machine.reduce(.chose(.eyes)), [])
        for _ in 0..<60 { XCTAssertEqual(machine.reduce(.foregroundSecond), []) }
        // Back, without saying which body: the chosen one is asked again.
        XCTAssertEqual(machine.reduce(.contextRestored(shown: nil)), [.request(.eyes)])
        // The page shows the character after all: it switches and says so; the owner's next choice goes through.
        XCTAssertEqual(machine.reduce(.switched(.eyes)), [.afterSwitch(.eyes)])
        XCTAssertEqual(machine.reduce(.chose(.human)), [.request(.human)])

        // When the page already shows the asked body it stays silent: the question runs out and that body is taken as
        // shown, without a reload, and a choice made meanwhile is asked then.
        var silent = Self.readySwitch(chosen: .eyes, shown: .eyes)
        _ = silent.reduce(.contextLost)
        XCTAssertEqual(silent.reduce(.contextRestored(shown: nil)), [.request(.eyes)])
        XCTAssertEqual(silent.reduce(.chose(.human)), [])
        for _ in 1..<BodySwitch.deadlineSeconds { XCTAssertEqual(silent.reduce(.foregroundSecond), []) }
        XCTAssertEqual(silent.reduce(.foregroundSecond), [.request(.human)])

        // The page of 10:43 answers a request for the body it shows: the confirmation ends at once.
        var answering = Self.readySwitch(chosen: .eyes, shown: .eyes)
        _ = answering.reduce(.contextLost)
        XCTAssertEqual(answering.reduce(.contextRestored(shown: nil)), [.request(.eyes)])
        XCTAssertEqual(answering.reduce(.switched(.eyes)), [.afterSwitch(.eyes)])
        XCTAssertNil(answering.pending)

        // A page that says which body it shows after mending (10:43) settles it at once.
        var saying = Self.readySwitch(chosen: .eyes, shown: .eyes)
        _ = saying.reduce(.contextLost)
        XCTAssertEqual(saying.reduce(.contextRestored(shown: .human)), [.request(.eyes)])
        var settled = Self.readySwitch(chosen: .eyes, shown: .eyes)
        _ = settled.reduce(.contextLost)
        XCTAssertEqual(settled.reduce(.contextRestored(shown: .eyes)), [])
        XCTAssertNil(settled.pending)
    }

    func testAnUnansweredSwitchEndsInAReloadAfterItsDeadline() {
        // The page ignored the request (it believed it showed that body already): the request is not kept for ever.
        var machine = Self.readySwitch(chosen: .eyes, shown: .eyes)
        XCTAssertEqual(machine.reduce(.chose(.human)), [.request(.human)])
        for _ in 1..<BodySwitch.deadlineSeconds { XCTAssertEqual(machine.reduce(.foregroundSecond), []) }
        XCTAssertEqual(machine.reduce(.foregroundSecond), [.recover])
        XCTAssertNil(machine.pending)
        XCTAssertEqual(BodySwitch.deadlineSeconds, 30)
    }

    func testAfterASwitchTheMouthLayoutAndCalmAreSaidAgain() {
        let layout = ShannonLive2DLayout(mode: .bust, scale: 1.4, offsetX: 10, contained: true)
        XCTAssertEqual(
            ShannonLive2DBodyPolicy.commandsAfterSwitch(to: .human, host: (layout, true), calm: (reduceMotion: true, lowPower: true)),
            [.setMouthLevel(0), .setLayout(layout), .setTouchEnabled(true), .setIdle(gestures: false, sway: 0), .setFrameRate(30)])
        // Her eyes alone have no mouth; a page without its own calm is not told one; no screen, no layout.
        XCTAssertEqual(
            ShannonLive2DBodyPolicy.commandsAfterSwitch(to: .eyes, host: (layout, false), calm: nil),
            [.setLayout(layout), .setTouchEnabled(false)])
        XCTAssertEqual(ShannonLive2DBodyPolicy.commandsAfterSwitch(to: .eyes, host: nil, calm: nil), [])
        XCTAssertEqual(
            ShannonLive2DStagePolicy.calmCommands(reduceMotion: false, lowPower: false), [.setIdle(gestures: true, sway: 1), .setFrameRate(0)])
    }

    func testHerEyesAloneBecomeAStillPictureUnderReduceMotion() {
        typealias Policy = ShannonLive2DStagePolicy
        // The page's calm reaches the character only.
        XCTAssertTrue(ShannonLive2DBodyPolicy.pageCalms(calmsInPage: true, body: .human))
        XCTAssertFalse(ShannonLive2DBodyPolicy.pageCalms(calmsInPage: true, body: .eyes))
        XCTAssertFalse(ShannonLive2DBodyPolicy.pageCalms(calmsInPage: false, body: .human))
        // The character under Reduce Motion is calmed by the page and keeps drawing.
        XCTAssertFalse(Policy.mayRest(reduceMotion: true, lowPower: false, calmsInPage: ShannonLive2DBodyPolicy.pageCalms(calmsInPage: true, body: .human)))
        // Her eyes alone under Reduce Motion: a still picture after five idle seconds, never with a finger on her.
        let eyesCalm = ShannonLive2DBodyPolicy.pageCalms(calmsInPage: true, body: .eyes)
        XCTAssertTrue(Policy.mayRest(reduceMotion: true, lowPower: false, calmsInPage: eyesCalm))
        XCTAssertTrue(Policy.rests(calm: true, phase: .idle, idleSeconds: 5, calmsInPage: eyesCalm))
        XCTAssertFalse(Policy.rests(calm: true, phase: .idle, idleSeconds: 4.9, calmsInPage: eyesCalm))
        XCTAssertFalse(Policy.rests(calm: true, phase: .idle, idleSeconds: 30, fingerDown: true, calmsInPage: eyesCalm))
        XCTAssertFalse(Policy.mayRest(reduceMotion: false, lowPower: false, calmsInPage: eyesCalm))
    }

    func testHerEyesAloneAreSentNoMouthLevelAndNoGesture() {
        typealias Policy = ShannonLive2DStagePolicy
        XCTAssertTrue(Policy.sendsMouthLevel(0.5, last: 0, body: .human))
        XCTAssertFalse(Policy.sendsMouthLevel(0.5, last: 0, body: .eyes))
        XCTAssertFalse(Policy.sendsMouthLevel(0, last: 0.5, body: .eyes))
        XCTAssertTrue(Policy.playsGesture("wave", known: ["wave"], body: .human))
        XCTAssertFalse(Policy.playsGesture("wave", known: ["wave"], body: .eyes))
        XCTAssertFalse(Policy.playsGesture("spin", known: ["wave"], body: .human))
    }

    // MARK: The embed page

    func testTheEmbedPageIsBundledAsAFolderWithItsFilesInPlace() throws {
        let folder = try XCTUnwrap(ShannonLive2DStage.embedFolder)
        for file in ["embed.html", "embed.js", "embed.css", "assets.js", "version.json", "live2d/live2d.js", "live2d/live2dcubismcore.min.js"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent(file).path), file)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.deletingLastPathComponent().appendingPathComponent("NOTICE.txt").path))
        let version = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("version.json"))) as? [String: Any]
        XCTAssertEqual(version?["modelUpdatedAt"] as? String, "2026-10-05T06:58:16.654Z")
        // The build of 2026-10-05 10:43 that carries her eyes alone (`setBody`, `embed.html?body=eyes`), which always
        // answers `body` and says the body in `contextRestored`.
        XCTAssertEqual(version?["version"] as? String, "0.1.0+202610051043")
        let files = version?["files"] as? [String] ?? []
        XCTAssertTrue(files.contains("model-eyes/Shannon_Eyes_v2.moc3"))
        XCTAssertTrue(files.contains("model/Shannon.moc3"))
    }

    func testThePageStartsInTheChosenBody() throws {
        let folder = URL(fileURLWithPath: "/bundle/Live2D/embed", isDirectory: true)
        XCTAssertEqual(ShannonLive2DStagePolicy.pageURL(in: folder, body: .human).absoluteString, "file:///bundle/Live2D/embed/embed.html")
        let eyes = ShannonLive2DStagePolicy.pageURL(in: folder, body: .eyes)
        XCTAssertTrue(eyes.isFileURL)
        XCTAssertEqual(eyes.path, "/bundle/Live2D/embed/embed.html")
        XCTAssertEqual(eyes.query, "body=eyes")
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
        // An older page has one body: the switch is asked for only when the page has it.
        XCTAssertEqual(
            ShannonLive2DCommand.setBody(.eyes).javaScript,
            #"window.shannonBody&&typeof window.shannonBody.setBody==='function'&&window.shannonBody.setBody("eyes");"#)
        XCTAssertEqual(
            ShannonLive2DCommand.setBody(.human).javaScript,
            #"window.shannonBody&&typeof window.shannonBody.setBody==='function'&&window.shannonBody.setBody("human");"#)
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
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "contextRestored", "attempts": 2]), .contextRestored())
        // The page of 10:43 says which body it rebuilt the surface with; an unknown body is left out, not the message.
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "contextRestored", "attempts": 1, "body": "eyes"]), .contextRestored(body: .eyes))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "contextRestored", "attempts": 1, "body": "human"]), .contextRestored(body: .human))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "contextRestored", "body": "tail"]), .contextRestored())
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
        // The page of 2026-10-05: the bodies it has and the one it shows, and a switch it made.
        XCTAssertEqual(
            ShannonLive2DMessage(body: [
                "type": "ready", "version": "v", "modelUpdatedAt": "m", "expressions": [], "gestures": [],
                "bodies": ["human", "eyes", "tail"], "body": "eyes",
            ]),
            .ready(version: "v", modelUpdatedAt: "m", expressions: [], gestures: [], bodies: [.human, .eyes], body: .eyes))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "body", "body": "eyes"]), .body(.eyes))
        XCTAssertEqual(ShannonLive2DMessage(body: ["type": "body", "body": "human"]), .body(.human))
        XCTAssertNil(ShannonLive2DMessage(body: ["type": "body", "body": "tail"]))
        XCTAssertNil(ShannonLive2DMessage(body: ["type": "body"]))
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

    @MainActor
    func testHerVoiceAnswersOnlyFromTheDialogueDisplayInFrontAndEveryOtherConditionStillHolds() {
        // The surface: Talk, its dialogue display, nothing over it (the body screen's "it is up", since A6).
        XCTAssertTrue(ShannonBodyModel.dialogueIsInFront(page: .talk, displayMode: .dialogue, covered: false))
        XCTAssertFalse(ShannonBodyModel.dialogueIsInFront(page: .talk, displayMode: .scroll, covered: false))
        XCTAssertFalse(ShannonBodyModel.dialogueIsInFront(page: .talk, displayMode: .dialogue, covered: true))
        XCTAssertFalse(ShannonBodyModel.dialogueIsInFront(page: .work, displayMode: .dialogue, covered: false))
        XCTAssertFalse(ShannonBodyModel.dialogueIsInFront(page: .shannon, displayMode: .dialogue, covered: false))

        func answers(
            front: Bool = true, active: Bool = true, audience: ShannonBodyAudience = .owner,
            mode: ShannonBodyReplyMode = .voice, reports: Bool = true, form: ShannonForm = .live2d
        ) -> Bool {
            ShannonBodyModel.answersInVoice(dialogueIsInFront: front, sceneIsActive: active, audience: audience, replyMode: mode, reportsTouch: reports, form: form)
        }
        XCTAssertTrue(answers())
        // Each condition alone is enough to keep her voice and the microphone off.
        XCTAssertFalse(answers(front: false))
        XCTAssertFalse(answers(active: false))
        XCTAssertFalse(answers(audience: .others))
        XCTAssertFalse(answers(mode: .text))
        XCTAssertFalse(answers(reports: false))
        XCTAssertFalse(answers(form: .waterlight))
        // A model that was never told the dialogue is in front answers in text.
        XCTAssertFalse(ShannonBodyModel().dialogueIsInFront)
    }

    func testEveryCoverOfTheDialogueDisplayHidesHerFigure() {
        let none = ShannonDialogueCovers(
            threadList: false, settings: false, callScreen: false, workTask: false,
            fileImporter: false, photoPicker: false, fromWords: false, cameraExplanation: false
        )
        // The covers the conversation root must name, each one: a new one is added here and there together.
        let covers: [(String, WritableKeyPath<ShannonDialogueCovers, Bool>)] = [
            ("threadList", \.threadList), ("settings", \.settings), ("callScreen", \.callScreen), ("workTask", \.workTask),
            ("fileImporter", \.fileImporter), ("photoPicker", \.photoPicker), ("fromWords", \.fromWords),
            ("cameraExplanation", \.cameraExplanation),
        ]
        XCTAssertEqual(Mirror(reflecting: none).children.compactMap(\.label), covers.map(\.0))
        // Every field is a Bool, so `isAny` reads each one; a field of another type would be skipped silently.
        XCTAssertEqual(Mirror(reflecting: none).children.count, 8)
        XCTAssertTrue(Mirror(reflecting: none).children.allSatisfy { $0.value is Bool })
        XCTAssertFalse(none.isAny)
        XCTAssertTrue(ShannonBodyModel.dialogueIsInFront(page: .talk, displayMode: .dialogue, covers: none))
        for (name, cover) in covers {
            var one = none
            one[keyPath: cover] = true
            XCTAssertTrue(one.isAny, name)
            XCTAssertFalse(ShannonBodyModel.dialogueIsInFront(page: .talk, displayMode: .dialogue, covers: one), name)
        }
    }

    func testOneListClosingItsSheetDoesNotUncoverAnothers() {
        let model = ShannonBodyModel()
        let first = UUID(), second = UUID()
        model.setCoverFromWords(first, isUp: true)
        model.setCoverFromWords(second, isUp: true)
        model.setCoverFromWords(first, isUp: false)
        XCTAssertTrue(model.sheetFromWordsIsUp)
        // A list that goes away twice, or one that never had a sheet up, changes nothing.
        model.setCoverFromWords(first, isUp: false)
        XCTAssertTrue(model.sheetFromWordsIsUp)
        model.setCoverFromWords(second, isUp: false)
        XCTAssertFalse(model.sheetFromWordsIsUp)
    }

    func testDictationWaitsWhileTheVoiceConversationHoldsTheMicrophone() {
        for phase in [ShannonGeminiLivePhase.requestingPermission, .connecting, .listening, .thinking, .speaking, .reconnecting] {
            XCTAssertTrue(ShannonConversationView.callHoldsMicrophone(phase), phase.rawValue)
        }
        XCTAssertFalse(ShannonConversationView.callHoldsMicrophone(.idle))
        XCTAssertFalse(ShannonConversationView.callHoldsMicrophone(.failed))
        // Only starting waits: dictation that already runs can be finished or stopped.
        for phase in [ShannonVoicePhase.idle, .denied, .failed] {
            XCTAssertTrue(ShannonConversationView.dictationWaits(dictation: phase, callHoldsMicrophone: true), phase.rawValue)
            XCTAssertFalse(ShannonConversationView.dictationWaits(dictation: phase, callHoldsMicrophone: false), phase.rawValue)
        }
        for phase in [ShannonVoicePhase.listening, .ready, .speaking] {
            XCTAssertFalse(ShannonConversationView.dictationWaits(dictation: phase, callHoldsMicrophone: true), phase.rawValue)
        }
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

    func testAPokeOnHerEyesGoesTheWayOfAnyPokeOnHerFace() async {
        // Her eyes alone: a short tap on them is `touch` and `askReaction` with type poke and region face.
        let eyesPoke: [String: Any] = ["type": "poke", "durationMs": 120, "strength": 0.3, "ongoing": false, "region": "face"]
        guard case let .touch(touch)? = ShannonLive2DMessage(body: ["type": "touch", "id": "e1", "occurredAt": "t", "touch": eyesPoke]) else {
            return XCTFail("a poke on her eyes is a touch")
        }
        XCTAssertEqual(touch.kind, .poke)
        XCTAssertEqual(touch.sentRegion, .face)
        XCTAssertEqual(ShannonBodyTouchEventDTO(touch: touch, audience: .owner).region, "face")
        XCTAssertEqual(ShannonBodyReactionRequestDTO(scopeKey: "owner", touch: touch, audience: .owner).touch.region, "face")
        let client = FakeBodyClient()
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: .init(
            reportsTouch: { true }, audience: { .owner }, capabilities: { (["joyful"], ["wave"]) }, express: { _, _ in }))
        await coordinator.handle(.askReaction(touch))?.value
        await coordinator.handle(.touch(touch))?.value
        let calls = await client.calls
        XCTAssertEqual(calls, ["register", "ask:e1:owner:ended", "events:e1:owner:120"])
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
        let outcomeHeard = FlagBox(true)
        let voiceMode = FlagBox(false)
        var environment = ShannonBodyTouchCoordinator.Environment(reportsTouch: { true }, capabilities: { ([], []) }, express: { _, _ in })
        environment.repliesInVoice = { voiceMode.value }
        environment.speak = { line, heard in
            spoken.values.append(line)
            heard(outcomeHeard.value)
        }
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
        XCTAssertNil(link.forTurn(companionPresent: false, utterance: "なに？", now: now))
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(60)), "t1")
        // A retry or a fallback of the same utterance keeps it; the next utterance does not get it.
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(200)), "t1")
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "それでね", now: now.addingTimeInterval(61)))
        // The stored turn of another utterance does not take it; the raw words of the same one do.
        XCTAssertNil(link.forTurn(companionPresent: false, utterance: "それでね", now: now.addingTimeInterval(100)))
        XCTAssertEqual(link.forTurn(companionPresent: false, utterance: "なに ？", now: now.addingTimeInterval(120)), "t1")
        XCTAssertNil(link.forTurn(companionPresent: false, utterance: "なに？", now: now.addingTimeInterval(121)))
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(122)))
        // Too late for the server's window: an ordinary turn.
        link.arm(reactionID: "t2", listenSeconds: 6, now: now)
        XCTAssertNil(link.forDelegation(ownerMode: true, utterance: "なに？", now: now.addingTimeInterval(67)))
        // A companion turned up between the delegation and the stored turn: the turn is stored without it.
        link.arm(reactionID: "t3", listenSeconds: 6, now: now)
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now), "t3")
        XCTAssertNil(link.forTurn(companionPresent: true, utterance: "なに？", now: now))
        // The stored turn comes later than the server keeps the link: stored without it.
        link.arm(reactionID: "t4", listenSeconds: 6, now: now)
        XCTAssertEqual(link.forDelegation(ownerMode: true, utterance: "なに？", now: now), "t4")
        XCTAssertNil(link.forTurn(companionPresent: false, utterance: "なに？", now: now.addingTimeInterval(601)))
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
        // The caller is told whether anything was said aloud: yes for a whole or a cut line, no otherwise.
        let heardAloud = LevelBox()
        func aloud(_ outcome: ShannonReachOutSpeechOutcome) async -> Double? {
            heardAloud.values = []
            speaker.outcome = outcome
            await voice.say(line(listen: 0)) { heardAloud.values.append($0 ? 1 : 0) }
            return heardAloud.values.first
        }
        var results: [Double?] = []
        for outcome in [ShannonReachOutSpeechOutcome.spoken, .cutShort, .notStarted, .failed] { results.append(await aloud(outcome)) }
        XCTAssertEqual(results, [1, 1, 0, 0])
        session.value = true
        let refused = await aloud(.spoken)
        XCTAssertEqual(refused, 0)
        voice.stop()
        XCTAssertEqual(speaker.stops, 1)

        // The call that listens: leaving while it still connects never lets the microphone go live.
        let observations = ObservationBox([
            .init(call: .starting, hasOwnerInput: false, hearsSound: false, isPrivate: true),
            .init(call: .starting, hasOwnerInput: false, hearsSound: false, isPrivate: false),
            .init(call: .live, hasOwnerInput: true, hearsSound: true, isPrivate: true),
        ])
        let left = await ShannonAnswerWait.run(seconds: 6, observe: { observations.next() }, sleep: { _ in true })
        XCTAssertEqual(left, .unavailable)
        XCTAssertEqual(observations.taken, 2)

        // Any call that begins starts without a touch line's id (the call screen, a call from her).
        ShannonBodyReactionLink.shared.arm(reactionID: "stale", listenSeconds: 6)
#if os(iOS)
        let workspace = ShannonVoiceWorkspaceState()
        _ = workspace.beginCall(
            mode: .owner, speechProvider: .gemini, threadID: nil,
            conversationModel: ShannonConversationModel.designPreview(), geminiVoiceModel: ShannonGeminiLiveSessionModel())
        workspace.connectionRequestID = nil
#else
        ShannonBodyReactionLink.shared.disarm()
#endif
        XCTAssertNil(ShannonBodyReactionLink.shared.forDelegation(ownerMode: true, utterance: "もしもし"))
    }

    func testALineSaidWithOthersAroundIsNeverSpokenAndASpokenLineIsMarked() async {
        let client = FakeBodyClient()
        await client.setAnswer(.init(
            id: "t1", status: "said",
            message: .init(id: "m1", text: "えへへ", expression: "bashful", feeling: nil, threadId: nil, listenSeconds: 6), mood: nil))
        let spoken = LineBox()
        let outcomeHeard = FlagBox(true)
        let audience = AudienceBox()
        var environment = ShannonBodyTouchCoordinator.Environment(
            reportsTouch: { true }, audience: { audience.value }, capabilities: { ([], []) }, express: { _, _ in })
        environment.repliesInVoice = { true }
        environment.speak = { line, heard in
            spoken.values.append(line)
            heard(outcomeHeard.value)
        }
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
        // Her voice came too late, or the sound was taken: the line was not said aloud after all, and VoiceOver reads the bubble.
        outcomeHeard.value = false
        await coordinator.handle(.askReaction(Self.touch("t1")))?.value
        for _ in 0..<50 where coordinator.isSpeaking { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(coordinator.line?.isSpoken, false)
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
@MainActor private final class ObservationBox: Sendable {
    private var values: [ShannonAnswerObservation]
    private(set) var taken = 0
    init(_ values: [ShannonAnswerObservation]) { self.values = values }
    func next() -> ShannonAnswerObservation {
        taken += 1
        return values.count > 1 ? values.removeFirst() : values[0]
    }
}

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
