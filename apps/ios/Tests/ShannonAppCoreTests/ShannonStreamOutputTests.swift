#if os(macOS)
import Foundation
import Network
import XCTest
@testable import ShannonAppCore

/// Roadmap A18 S5 (`desktop.stream-output`, `desktop.stream-output-body`): her figure for an OBS browser source, served
/// on this Mac's loopback only, and the audience it makes.
final class ShannonStreamOutputTests: XCTestCase {
    private let port: UInt16 = 41760

    private func request(
        _ path: String, method: String = "GET", host: String? = "127.0.0.1:41760", origin: String? = nil, site: String? = nil
    ) -> ShannonStreamOutputHTTP.Request {
        var headers: [String: String] = [:]
        if let host { headers["host"] = host }
        if let origin { headers["origin"] = origin }
        if let site { headers["sec-fetch-site"] = site }
        return .init(method: method, path: path, headers: headers)
    }

    private func files() -> ShannonStreamOutputFiles {
        var entries: [String: ShannonStreamOutputFiles.Entry] = [:]
        for item in ShannonStreamOutputFiles.layout {
            entries[item.path] = .init(url: URL(fileURLWithPath: "/bundle\(item.path)"), contentType: item.type)
        }
        return ShannonStreamOutputFiles(entries: entries)
    }

    // MARK: Routes

    func testItServesOnlyThePageItsBodyFilesAndTheEventStream() {
        let files = files()
        for path in ["/stream.html", "/stream.js", "/embed.css", "/assets.js", "/embed.js", "/live2d/live2d.js", "/live2d/live2dcubismcore.min.js"] {
            guard case let .file(entry) = ShannonStreamOutputHTTP.route(request(path), port: port, files: files) else {
                return XCTFail(path)
            }
            XCTAssertEqual(entry.url.path, "/bundle\(path)")
        }
        XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/events"), port: port, files: files), .events)
        for path in ["/", "/embed.html", "/version.json", "/README.md", "/../etc/passwd", "/live2d/../assets.js", "/%2e%2e/x", "/favicon.ico", "/model/Shannon.moc3"] {
            XCTAssertEqual(ShannonStreamOutputHTTP.route(request(path), port: port, files: files), .refused(status: 404), path)
        }
        XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/events", method: "POST"), port: port, files: files), .refused(status: 405))
        XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/stream.html", method: "HEAD"), port: port, files: files), .refused(status: 405))
        // The query of the page's own address (`?body=eyes`) does not change what is served.
        guard case .request(let parsed) = ShannonStreamOutputHTTP.parse(Data("GET /stream.html?body=eyes HTTP/1.1\r\nHost: 127.0.0.1:41760\r\n\r\n".utf8)) else {
            return XCTFail("not parsed")
        }
        XCTAssertEqual(parsed.path, "/stream.html")
        XCTAssertEqual(parsed.headers["host"], "127.0.0.1:41760")
    }

    func testAPageOfAnotherSiteIsRefusedByItsHostAndItsOrigin() {
        let files = files()
        // DNS rebinding: a site that resolved its own name to 127.0.0.1 still says its name.
        for host in [nil, "evil.example:41760", "evil.example", "127.0.0.1", "127.0.0.1:41761", "192.168.1.5:41760", "[::1]:41760", "localhost.evil.example:41760"] {
            XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/events", host: host), port: port, files: files), .refused(status: 403), host ?? "none")
        }
        XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/events", host: "LOCALHOST:41760"), port: port, files: files), .events)
        for origin in ["http://evil.example", "null", "https://127.0.0.1:41760", "http://127.0.0.1:41761"] {
            XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/events", origin: origin), port: port, files: files), .refused(status: 403), origin)
        }
        XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/events", origin: "http://127.0.0.1:41760"), port: port, files: files), .events)
    }

    func testARequestFromAnotherSitesPageIsRefusedByItsFetchSite() {
        let files = files()
        // What OBS's browser sends for the page it was given, and for the page's own reads.
        XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/events", site: "same-origin"), port: port, files: files), .events)
        guard case .file = ShannonStreamOutputHTTP.route(request("/stream.html", site: "none"), port: port, files: files) else {
            return XCTFail("the page itself, typed or set as a source")
        }
        // Another site's page, also a plain <script> or <img> that sends no Origin; another port of this Mac is same-site.
        for site in ["cross-site", "same-site", "CROSS-SITE", "unknown"] {
            XCTAssertEqual(ShannonStreamOutputHTTP.route(request("/assets.js", site: site), port: port, files: files), .refused(status: 403), site)
        }
        XCTAssertTrue(ShannonStreamOutputHTTP.contentSecurityPolicy.hasSuffix("frame-ancestors 'none'"))
    }

    func testARequestHeadIsReadWhenCompleteAndRefusedWhenMalformedOrLarge() {
        XCTAssertEqual(ShannonStreamOutputHTTP.parse(Data("GET /stream.html HTTP/1.1\r\nHost: 127.0.0.1:41760\r\n".utf8)), .incomplete)
        XCTAssertEqual(ShannonStreamOutputHTTP.parse(Data("GET /stream.html\r\n\r\n".utf8)), .malformed)
        XCTAssertEqual(ShannonStreamOutputHTTP.parse(Data("GET stream.html HTTP/1.1\r\n\r\n".utf8)), .malformed)
        XCTAssertEqual(ShannonStreamOutputHTTP.parse(Data("GET / HTTP/1.1\r\nno colon\r\n\r\n".utf8)), .malformed)
        XCTAssertEqual(ShannonStreamOutputHTTP.parse(Data(repeating: 65, count: ShannonStreamOutputHTTP.maximumHeadBytes + 1)), .malformed)
    }

    func testOnlyALoopbackPeerIsServed() throws {
        func peer(_ host: NWEndpoint.Host) -> NWEndpoint { .hostPort(host: host, port: 50_000) }
        XCTAssertTrue(ShannonStreamOutputServer.isLoopback(peer(.ipv4(.loopback))))
        XCTAssertTrue(ShannonStreamOutputServer.isLoopback(peer(.ipv4(try XCTUnwrap(IPv4Address("127.0.0.9"))))))
        XCTAssertTrue(ShannonStreamOutputServer.isLoopback(peer(.ipv6(.loopback))))
        XCTAssertTrue(ShannonStreamOutputServer.isLoopback(peer(.ipv6(try XCTUnwrap(IPv6Address("::ffff:127.0.0.1"))))))
        XCTAssertFalse(ShannonStreamOutputServer.isLoopback(peer(.ipv4(try XCTUnwrap(IPv4Address("192.168.1.5"))))))
        XCTAssertFalse(ShannonStreamOutputServer.isLoopback(peer(.ipv4(try XCTUnwrap(IPv4Address("10.0.0.1"))))))
        XCTAssertFalse(ShannonStreamOutputServer.isLoopback(peer(.ipv6(try XCTUnwrap(IPv6Address("::ffff:192.168.1.5"))))))
        XCTAssertFalse(ShannonStreamOutputServer.isLoopback(peer(.ipv6(try XCTUnwrap(IPv6Address("fe80::1"))))))
        XCTAssertFalse(ShannonStreamOutputServer.isLoopback(peer(.name("localhost", nil))))
    }

    // MARK: Server-sent events

    func testEventsAreOneDataLineOfJSONInOneChunk() throws {
        XCTAssertEqual(ShannonStreamOutputHTTP.event(#"{"call":"play","args":["wave"]}"#), Data("data: {\"call\":\"play\",\"args\":[\"wave\"]}\n\n".utf8))
        XCTAssertNil(ShannonStreamOutputHTTP.event("{\n}"))
        XCTAssertNil(ShannonStreamOutputHTTP.event("a\rb"))
        XCTAssertNil(ShannonStreamOutputHTTP.event(""))
        XCTAssertEqual(ShannonStreamOutputHTTP.chunk(Data("data: x\n\n".utf8)), Data("9\r\ndata: x\n\n\r\n".utf8))
        XCTAssertEqual(ShannonStreamOutputHTTP.chunk(Data()), Data())
        XCTAssertEqual(ShannonStreamOutputHTTP.opening, Data("retry: 1000\n\n".utf8))
        let head = String(decoding: ShannonStreamOutputHTTP.eventsHead(), as: UTF8.self)
        XCTAssertTrue(head.hasPrefix("HTTP/1.1 200 OK\r\n"))
        XCTAssertTrue(head.contains("Content-Type: text/event-stream; charset=utf-8\r\n"))
        XCTAssertTrue(head.contains("Transfer-Encoding: chunked\r\n"))
        XCTAssertTrue(head.contains("Cache-Control: no-store\r\n"))
        XCTAssertFalse(head.contains("Access-Control-Allow-Origin"))
        XCTAssertTrue(head.hasSuffix("\r\n\r\n"))
    }

    func testHerCallsAreSentAsDataAndNeverAsScript() throws {
        // A name from the server stays a JSON string: nothing it says can become script on the page.
        let hostile = ShannonLive2DCommand.express(expression: "joyful\");alert(1);//</script>\n", feeling: nil, seconds: nil).streamEvent
        let event = try XCTUnwrap(hostile)
        XCTAssertFalse(event.payload.contains("\n"))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(event.payload.utf8)) as? [String: Any])
        XCTAssertEqual(decoded["call"] as? String, "express")
        let args = try XCTUnwrap(decoded["args"] as? [Any])
        XCTAssertEqual(args.first as? String, "joyful\");alert(1);//</script>\n")
        XCTAssertTrue(args[1] is NSNull)
        XCTAssertEqual(ShannonLive2DCommand.setPhase(.speaking).streamEvent?.payload, #"{"args":["speaking"],"call":"setPhase"}"#)
        XCTAssertEqual(ShannonLive2DCommand.setBody(.eyes).streamEvent?.payload, #"{"args":["eyes"],"call":"setBody"}"#)
        let presence = ShannonLive2DPresence(expression: "tender", feeling: nil, intensity: 0.4, doing: "reading", awaitingReaction: 2)
        let sent = try XCTUnwrap(ShannonLive2DCommand.setPresence(presence).streamEvent?.payload)
        let fields = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any])?["args"] as? [[String: Any]]).first
        // The body contract's presence and nothing more: a face and its strength, what she does, how many stories wait.
        XCTAssertEqual(Set(fields?.keys ?? [:].keys), ["expression", "feeling", "intensity", "doing", "awaitingReaction"])
        // Where she stands, pausing, touch and the rest belong to the stream page itself.
        for command in [ShannonLive2DCommand.setPaused(true), .setTouchEnabled(true), .setFrameStats(true), .setFrameRate(30),
                        .setIdle(gestures: false, sway: 0), .setLayout(ShannonLive2DLayout(mode: .bust))] {
            XCTAssertNil(command.streamEvent)
        }
    }

    func testANewPageIsToldHerBodyFirstAndOnlyChangesAreSent() {
        var snapshot = ShannonStreamOutputSnapshot(body: .human)
        XCTAssertEqual(snapshot.opening.map(\.call), ["setBody"])
        XCTAssertNotNil(snapshot.take(.setPhase(.thinking)))
        XCTAssertNil(snapshot.take(.setPhase(.thinking)))
        XCTAssertNotNil(snapshot.take(.setMood(valence: 0.2, arousal: 0.1, openness: 0.5)))
        XCTAssertNil(snapshot.take(.setBody(.human)))
        XCTAssertEqual(snapshot.opening.map(\.call), ["setBody", "setMood", "setPhase"])
        // Faces and gestures are moments: sent each time, never kept for the next page.
        XCTAssertNotNil(snapshot.take(.express(expression: "joyful", feeling: nil, seconds: nil)))
        XCTAssertNotNil(snapshot.take(.express(expression: "joyful", feeling: nil, seconds: nil)))
        XCTAssertNotNil(snapshot.take(.play("wave")))
        XCTAssertEqual(snapshot.opening.count, 3)
        // Her mouth: a change of note and the return to zero, as in the app's own page.
        XCTAssertNotNil(snapshot.take(.setMouthLevel(0.5)))
        XCTAssertNil(snapshot.take(.setMouthLevel(0.51)))
        XCTAssertNotNil(snapshot.take(.setMouthLevel(0)))
        XCTAssertNil(snapshot.take(.setMouthLevel(0)))
        XCTAssertNil(snapshot.take(.setLayout(ShannonLive2DLayout(mode: .full))))
        // Her eyes alone have no mouth and no arms.
        XCTAssertNotNil(snapshot.take(.setBody(.eyes)))
        XCTAssertNil(snapshot.take(.setMouthLevel(0.8)))
        XCTAssertNil(snapshot.take(.play("wave")))
        XCTAssertEqual(snapshot.opening.first?.payload, #"{"args":["eyes"],"call":"setBody"}"#)
    }

    func testAPageThatConnectsFirstIsToldWhatHerFigureWasLastTold() {
        let presence = ShannonLive2DPresence(expression: "tender", feeling: nil, intensity: 0.3, doing: "reading", awaitingReaction: 1)
        let snapshot = ShannonStreamOutputSnapshot.seeded(
            body: .human, mood: (valence: 0.4, arousal: 0.2, openness: 0.6), presence: presence, phase: .speaking)
        XCTAssertEqual(snapshot.opening.map(\.call), ["setBody", "setMood", "setPresence", "setPhase"])
        XCTAssertEqual(snapshot.opening.last?.payload, #"{"args":["speaking"],"call":"setPhase"}"#)
        let bare = ShannonStreamOutputSnapshot.seeded(body: .eyes, mood: nil, presence: nil, phase: .idle)
        XCTAssertEqual(bare.opening.map(\.call), ["setBody", "setPhase"])
    }

    // MARK: The page

    @MainActor
    func testTheStreamPageLoadsTheBundledBodyPageAsEmbedHtmlDoes() throws {
        let embed = try XCTUnwrap(ShannonLive2DStage.embedFolder)
        let stream = embed.deletingLastPathComponent().appendingPathComponent("stream", isDirectory: true)
        let embedHTML = try String(contentsOf: embed.appendingPathComponent("embed.html"), encoding: .utf8)
        let streamHTML = try String(contentsOf: stream.appendingPathComponent("stream.html"), encoding: .utf8)
        let streamJS = try String(contentsOf: stream.appendingPathComponent("stream.js"), encoding: .utf8)
        XCTAssertNotNil(ShannonStreamOutputFiles.bundled)
        // The same scripts in the same order, every one of them served, and the same stage.
        let scripts = try NSRegularExpression(pattern: #"<script src="([^"]+)"></script>"#)
            .matches(in: embedHTML, range: NSRange(embedHTML.startIndex..., in: embedHTML))
            .compactMap { Range($0.range(at: 1), in: embedHTML).map { String(embedHTML[$0]) } }
        XCTAssertEqual(scripts, ["assets.js", "live2d/live2dcubismcore.min.js", "live2d/live2d.js", "embed.js"])
        let listed = "var SCRIPTS = [" + scripts.map { "'\($0)'" }.joined(separator: ", ") + "];"
        XCTAssertTrue(streamJS.contains(listed), "stream.js must load \(scripts)")
        for script in scripts { XCTAssertNotNil(ShannonStreamOutputFiles.bundled?.entries["/\(script)"], script) }
        let stage = #"<div id="stage" aria-label="シャノン" data-max-pixel-ratio="3" data-max-drawing-height="4096"></div>"#
        XCTAssertTrue(embedHTML.contains(stage))
        XCTAssertTrue(streamHTML.contains(stage))
        XCTAssertTrue(streamHTML.contains(#"<link rel="stylesheet" href="embed.css">"#))
        // The page calls only the names it is given, and reads events as data.
        XCTAssertFalse(streamJS.contains("eval("))
        XCTAssertFalse(streamJS.contains("new Function"))
        for call in ShannonStreamOutputEvent.calls { XCTAssertTrue(streamJS.contains("\(call): true"), call) }
        XCTAssertTrue(streamJS.contains("new EventSource('/events')"))
    }

    // MARK: The owner's switch and the audience

    @MainActor
    func testTheSwitchIsOffByDefault() {
        let defaults = UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!
        XCTAssertFalse(ShannonStreamOutput.isOn(defaults))
        let output = ShannonStreamOutput(defaults: defaults, port: 0)
        XCTAssertFalse(output.isOn)
        XCTAssertFalse(output.othersPresent)
        XCTAssertEqual(output.state, .off)
        XCTAssertEqual(output.pageURL.absoluteString, "http://127.0.0.1:0/stream.html")
        XCTAssertEqual(ShannonStreamOutput(defaults: defaults).pageURL.absoluteString, "http://127.0.0.1:41760/stream.html")
    }

    @MainActor
    func testWhileItIsOnHerBodiesOnTheMacSayOthersArePresent() {
        XCTAssertEqual(ShannonStreamOutput.audience(streamOutputOn: true, held: .owner), .others)
        XCTAssertEqual(ShannonStreamOutput.audience(streamOutputOn: false, held: .owner), .owner)
        XCTAssertEqual(ShannonStreamOutput.audience(streamOutputOn: false, held: .others), .others)
        let defaults = UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!
        defaults.set(true, forKey: ShannonStreamOutput.settingKey)
        let body = ShannonDesktopBody()
        body.audienceRule = ShannonBodyAudienceRule()
        body.streamOutput = ShannonStreamOutput(defaults: UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!, port: 0)
        XCTAssertEqual(body.audience, .owner)
        // Left on at the last run: others from launch, before anything listens.
        body.streamOutput = ShannonStreamOutput(defaults: defaults, port: 0)
        XCTAssertEqual(body.audience, .others)
        // So she takes no look at the room, and her touch is not answered aloud as to the owner alone.
        XCTAssertEqual(body.cameraState, ShannonDesktopBodyCameraState.make(
            cameraAllowed: body.cameraAllowed, permission: body.cameraPermission, hasCamera: body.hasCamera, othersPresent: true, isCapturing: false))
        XCTAssertFalse(ShannonDesktopBody.answersTouchInVoice(shown: true, replyMode: .voice, reportsTouch: true, audience: body.audience, ownerInCallElsewhere: false))
    }

    @MainActor
    func testAnOutputThatCannotStartGoesBackOffAndSaysWhy() {
        let defaults = UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!
        let output = ShannonStreamOutput(defaults: defaults, port: 0, files: { nil })
        output.setOn(true)
        XCTAssertFalse(output.isOn)
        XCTAssertFalse(ShannonStreamOutput.isOn(defaults))
        XCTAssertEqual(output.state, .failed(ShannonGeneratedStrings.desktopStreamUnavailable))
    }

    @MainActor
    func testTheMenuBarItemHasTheSwitchAndTheAddressOnlyWhileItIsOut() {
        let menuBar = ShannonDesktopMenuBar()
        menuBar.makesStatusItem = false
        let body = ShannonDesktopBody()
        body.streamOutput = ShannonStreamOutput(defaults: UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!, port: 0)
        menuBar.register(ShannonDesktopBodyMenuSection(body: body, menuBar: menuBar))
        let items = menuBar.currentItems()
        let stream = items.first { $0.title == ShannonGeneratedStrings.desktopStreamTitle }
        XCTAssertEqual(stream?.state, .off)
        XCTAssertFalse(items.contains { $0.title == ShannonGeneratedStrings.desktopStreamCopyURL })
        withExtendedLifetime(body) {}
    }

    func testAPortHeldByAnotherListenerIsSaidToBeTakenAndNeverShared() async throws {
        XCTAssertTrue(ShannonStreamOutputServer.isPortTaken(NWError.posix(.EADDRINUSE)))
        XCTAssertFalse(ShannonStreamOutputServer.isPortTaken(NWError.posix(.EACCES)))
        let firstStates = StateBox()
        let first = ShannonStreamOutputServer(port: 0, files: files(), snapshot: .init()) { firstStates.append($0) }
        first.start()
        defer { first.stop() }
        let port = try await firstStates.port()
        // Another build of the app, or the old Electron app, on the same port.
        let secondStates = StateBox()
        let second = ShannonStreamOutputServer(port: port, files: files(), snapshot: .init()) { secondStates.append($0) }
        second.start()
        let taken = await secondStates.wait { if case .failed(_, true) = $0 { true } else { false } }
        XCTAssertTrue(taken, "the second listener is refused the port")
        let released = await secondStates.wait { $0 == .stopped }
        XCTAssertTrue(released)
    }

    @MainActor
    func testTurningItOffAndOnAgainWaitsForItsOldListenerAndTellsATakenPortApart() async throws {
        // A free port: one the system gives, let go again.
        let probeStates = StateBox()
        let probe = ShannonStreamOutputServer(port: 0, files: files(), snapshot: .init()) { probeStates.append($0) }
        probe.start()
        let port = try await probeStates.port()
        probe.stop()
        let probeReleased = await probeStates.wait { $0 == .stopped }
        XCTAssertTrue(probeReleased)

        let output = ShannonStreamOutput(
            defaults: UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!, port: port, capture: ShannonStreamOutputWindowCapture())
        output.setOn(true)
        for _ in 0..<200 where output.state != .live { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(output.state, .live)
        output.setOn(false)
        output.setOn(true)
        for _ in 0..<300 where output.state != .live { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(output.state, .live, "the new listener waited for the old one to let the port go")
        XCTAssertEqual(output.listeningPort, port)

        // Held by another listener: said as taken, and the switch goes back off.
        let other = ShannonStreamOutput(
            defaults: UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!, port: port, capture: ShannonStreamOutputWindowCapture())
        other.setOn(true)
        for _ in 0..<300 where other.isOn { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(other.state, .failed(ShannonGeneratedStrings.desktopStreamPortTaken(port: String(port))))
        output.setOn(false)
    }

    // MARK: Over a socket

    @MainActor
    func testItServesThePageAndStreamsHerCallsOnLoopback() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("stream-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var entries: [String: ShannonStreamOutputFiles.Entry] = [:]
        for item in ShannonStreamOutputFiles.layout {
            let url = folder.appendingPathComponent(item.file.replacingOccurrences(of: "/", with: "_"))
            try Data("file \(item.file)".utf8).write(to: url)
            entries[item.path] = .init(url: url, contentType: item.type)
        }
        let states = StateBox()
        let server = ShannonStreamOutputServer(port: 0, files: ShannonStreamOutputFiles(entries: entries), snapshot: ShannonStreamOutputSnapshot(body: .eyes)) {
            states.append($0)
        }
        server.start()
        defer { server.stop() }
        let port = try await states.port()
        XCTAssertNotEqual(port, 0)

        let page = try await RawHTTP.exchange(port: port, "GET /stream.html HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n") { $0.hasSuffix("file stream.html") }
        XCTAssertTrue(page.hasPrefix("HTTP/1.1 200 OK\r\n"), page)
        XCTAssertTrue(page.contains("Content-Type: text/html; charset=utf-8\r\n"))
        XCTAssertTrue(page.contains("Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval';"))
        XCTAssertTrue(page.contains("connect-src 'self' blob: data:;"))

        let rebound = try await RawHTTP.exchange(port: port, "GET /stream.html HTTP/1.1\r\nHost: shannon.evil.example:\(port)\r\n\r\n") { $0.contains("\r\n\r\n") }
        XCTAssertTrue(rebound.hasPrefix("HTTP/1.1 403 Forbidden\r\n"), rebound)
        XCTAssertFalse(rebound.contains("file stream.html"))
        let unknown = try await RawHTTP.exchange(port: port, "GET /embed.html HTTP/1.1\r\nHost: localhost:\(port)\r\n\r\n") { $0.contains("\r\n\r\n") }
        XCTAssertTrue(unknown.hasPrefix("HTTP/1.1 404 Not Found\r\n"), unknown)
        let garbage = try await RawHTTP.exchange(port: port, "HELLO\r\n\r\n") { $0.contains("\r\n\r\n") }
        XCTAssertTrue(garbage.hasPrefix("HTTP/1.1 400 Bad Request\r\n"), garbage)

        // The event stream: chunked, the retry, her body first, then each call as it is made.
        let watcher = RawHTTP(port: port)
        try await watcher.open()
        defer { watcher.close() }
        watcher.send("GET /events HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nAccept: text/event-stream\r\n\r\n")
        let opening = try await watcher.read { $0.contains(#""call":"setBody""#) }
        XCTAssertTrue(opening.hasPrefix("HTTP/1.1 200 OK\r\n"), opening)
        XCTAssertTrue(opening.contains("Transfer-Encoding: chunked\r\n"))
        XCTAssertTrue(opening.contains("retry: 1000\n\n"))
        XCTAssertTrue(opening.contains("data: {\"args\":[\"eyes\"],\"call\":\"setBody\"}\n\n"))
        server.publish(.express(expression: "joyful", feeling: "proud", seconds: 4))
        let next = try await watcher.read { $0.contains(#""call":"express""#) }
        XCTAssertTrue(next.contains(#"data: {"args":["joyful","proud",4],"call":"express"}"#), next)
    }

    @MainActor
    func testTurningItOnListensAndHerFiguresCallsReachThePage() async throws {
        let defaults = UserDefaults(suiteName: "stream-output-\(UUID().uuidString)")!
        let probe = ShannonStreamOutput(defaults: defaults, port: 0)
        probe.setOn(true)
        defer { probe.setOn(false) }
        for _ in 0..<100 where probe.state != .live { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(probe.state, .live)
        XCTAssertTrue(probe.isOn)
        XCTAssertTrue(ShannonStreamOutput.isOn(defaults))
        XCTAssertNotNil(ShannonLive2DDesktopLink.shared.streamMirror)
        let port = try XCTUnwrap(probe.listeningPort)
        let watcher = RawHTTP(port: port)
        try await watcher.open()
        defer { watcher.close() }
        watcher.send("GET /events HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n")
        _ = try await watcher.read { $0.contains(#""call":"setBody""#) }
        // What the app tells her figure reaches the stream page, also with no window of the app showing her.
        ShannonLive2DStage.shared.express("surprised", seconds: 3)
        let said = try await watcher.read { $0.contains(#""surprised""#) }
        XCTAssertTrue(said.contains(#"data: {"args":["surprised",null,3],"call":"express"}"#), said)
        probe.setOn(false)
        XCTAssertEqual(probe.state, .off)
        XCTAssertFalse(ShannonStreamOutput.isOn(defaults))
        XCTAssertNil(ShannonLive2DDesktopLink.shared.streamMirror)
    }
}

/// The listener's states, for a test that waits for its port.
private final class StateBox: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [ShannonStreamOutputServer.State] = []

    func append(_ state: ShannonStreamOutputServer.State) {
        lock.withLock { states.append(state) }
    }

    func wait(for wanted: @Sendable (ShannonStreamOutputServer.State) -> Bool) async -> Bool {
        for _ in 0..<300 {
            if lock.withLock({ states.contains(where: wanted) }) { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }

    func port() async throws -> UInt16 {
        for _ in 0..<200 {
            let current = lock.withLock { states }
            for state in current {
                if case let .listening(port) = state { return port }
                if case let .failed(reason, _) = state { throw NSError(domain: "stream", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(domain: "stream", code: 2)
    }
}

/// A raw HTTP exchange over TCP, so that a test can send any Host header.
private final class RawHTTP: @unchecked Sendable {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "stream-output-test")
    private let lock = NSLock()
    private var received = Data()

    init(port: UInt16) {
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    }

    static func exchange(port: UInt16, _ text: String, until done: @escaping @Sendable (String) -> Bool) async throws -> String {
        let client = RawHTTP(port: port)
        try await client.open()
        defer { client.close() }
        client.send(text)
        return try await client.read(until: done)
    }

    func open() async throws {
        connection.start(queue: queue)
        for _ in 0..<200 {
            if case .ready = connection.state { receiveMore(); return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(domain: "stream", code: 3)
    }

    func send(_ text: String) {
        connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
    }

    func read(until done: @Sendable (String) -> Bool) async throws -> String {
        for _ in 0..<300 {
            let text = lock.withLock { String(decoding: received, as: UTF8.self) }
            if done(text) { return text }
            try await Task.sleep(for: .milliseconds(10))
        }
        return lock.withLock { String(decoding: received, as: UTF8.self) }
    }

    func close() { connection.cancel() }

    private func receiveMore() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data {
                self.lock.withLock { self.received.append(data) }
            }
            if !isComplete, error == nil { self.receiveMore() }
        }
    }
}
#endif
