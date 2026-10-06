#if os(macOS)
import CryptoKit
import Foundation
import XCTest
@testable import ShannonAppCore

/// Roadmap A18 S2: her folder on the Mac, read-only (`docs/host-folder-contract.md`). The fence, the operations and
/// their bounds on a real temporary folder, the bookmark, the local stop, and the wire against the server's shapes.
final class ShannonFolderHostTests: XCTestCase {
    private var base: URL!
    private var folder: URL!
    private var outside: URL!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("shannon-folder-\(UUID().uuidString)", isDirectory: true)
        folder = base.appendingPathComponent("シャノン用", isDirectory: true)
        outside = base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try ShannonFolderHostAdoption.adopt(folder)
        try "secret".write(to: outside.appendingPathComponent("secret.md"), atomically: true, encoding: .utf8)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    private func write(_ relative: String, _ text: String) throws {
        try write(relative, Data(text.utf8))
    }

    private func write(_ relative: String, _ data: Data) throws {
        let url = folder.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private func root() throws -> ShannonFolderHostRoot { try ShannonFolderHostRoot(folder: folder) }

    private func refusal(_ body: () throws -> Void) -> ShannonFolderHostCode? {
        do { try body(); return nil } catch let refusal as ShannonFolderHostRefusal { return refusal.code } catch { return .unknown }
    }

    // MARK: The path rules, with the server as the oracle

    func testThePathRulesAgreeWithEveryCaseTheServerRecorded() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        struct Case: Decodable { let value: String; let kind: String; let path: String? }
        struct Fixture: Decodable { let cases: [Case] }
        let data = try Data(contentsOf: repository.appending(path: "services/api/tests/fixtures/host-folder-paths-v1/cases.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        XCTAssertGreaterThan(fixture.cases.count, 200)
        for item in fixture.cases {
            let kind = try XCTUnwrap(ShannonFolderHostPath.Kind(rawValue: item.kind))
            XCTAssertEqual(ShannonFolderHostPath.checked(item.value, kind: kind), item.path, "\(item.value.debugDescription) as \(item.kind)")
        }
    }

    func testDotShannonIsRefusedInEverySpellingTheDiskCouldResolve() throws {
        let root = try root()
        for spelling in [".shannon", ".SHANNON", ".Shannon", ".ſhannon", "．ｓｈａｎｎｏｎ", ".shannon".decomposedStringWithCanonicalMapping, ".SHAN\u{004E}ON"] {
            XCTAssertTrue(ShannonFolderHostPath.isProtectedName(spelling), spelling)
            XCTAssertEqual(refusal { _ = try root.locate("\(spelling)/folder.json", kind: .file) }, .protectedPath, spelling)
            XCTAssertEqual(refusal { _ = try root.locate(spelling, kind: .folder) }, .protectedPath, spelling)
        }
        XCTAssertFalse(ShannonFolderHostPath.isProtectedName(".shannonx"))
        // The listing never shows it, and a name the disk stores decomposed is found when asked for composed.
        try write("メモ/が.md".decomposedStringWithCanonicalMapping, "かな")
        let listed = try ShannonFolderHostOperations.list(root, relativePath: "", recursive: true, limit: 500)
        XCTAssertFalse(listed.entries.contains { $0.path.lowercased().hasPrefix(".shannon") })
        XCTAssertEqual(try ShannonFolderHostOperations.read(root, relativePath: "メモ/が.md".precomposedStringWithCanonicalMapping, offset: 0, maxBytes: 100).content, "かな")
    }

    // MARK: Links, aliases, packages

    func testLinksAliasesAndPackagesAreNeverFollowedOrReadAsText() throws {
        let root = try root()
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("link.md").path, withDestinationPath: outside.appendingPathComponent("secret.md").path)
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("away").path, withDestinationPath: outside.path)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "link.md", offset: 0, maxBytes: 100) }, .linkRefused)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "away/secret.md", offset: 0, maxBytes: 100) }, .linkRefused)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.list(root, relativePath: "away", recursive: false, limit: 10) }, .linkRefused)

        // A Finder alias to the outside file, named like a text file.
        let alias = folder.appendingPathComponent("alias.md")
        try URL.writeBookmarkData(try outside.appendingPathComponent("secret.md").bookmarkData(options: .suitableForBookmarkFile), to: alias)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "alias.md", offset: 0, maxBytes: 100) }, .notText)

        // A package is one file: listed, never entered, never read.
        try write("Tool.app/Contents/readme.md", "inside")
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "Tool.app/Contents/readme.md", offset: 0, maxBytes: 100) }, .notAFolder)

        let listed = try ShannonFolderHostOperations.list(root, relativePath: "", recursive: true, limit: 500)
        XCTAssertEqual(listed.entries.map(\.path), ["Tool.app", "alias.md"])
        XCTAssertEqual(listed.entries.first?.type, "file")
        let found = try ShannonFolderHostOperations.search(root, query: "secret", relativePath: "", limit: 20)
        XCTAssertEqual(found.hits, [])
    }

    // MARK: Content

    func testOnlyValidUTF8WithoutNULIsText() throws {
        let root = try root()
        try write("bad.md", Data([0x61, 0xFF, 0xFE]))
        try write("zero.txt", Data([0x61, 0x00, 0x62]))
        try write("run.sh", "echo")
        try write("folder.md/inner.md", "x")
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "bad.md", offset: 0, maxBytes: 100) }, .notText)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "zero.txt", offset: 0, maxBytes: 100) }, .notText)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "run.sh", offset: 0, maxBytes: 100) }, .notText)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "folder.md", offset: 0, maxBytes: 100) }, .notAFile)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "missing.md", offset: 0, maxBytes: 100) }, .notFound)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "../outside/secret.md", offset: 0, maxBytes: 100) }, .pathNotAllowed)
        try write("big.md", String(repeating: "a", count: ShannonFolderHostLimits.fileBytes + 1))
        XCTAssertEqual(refusal { _ = try ShannonFolderHostOperations.read(root, relativePath: "big.md", offset: 0, maxBytes: 100) }, .tooLarge)
    }

    func testReadPagesAtCharacterBoundariesAndDigestsTheWholeFile() throws {
        let text = "夕方の駅は光が低い。\n" + String(repeating: "あいうえお😀", count: 40)
        try write("notes/旅.md", text)
        let root = try root()
        var offset = 0
        var collected = ""
        var pages = 0
        repeat {
            let page = try ShannonFolderHostOperations.read(root, relativePath: "notes/旅.md", offset: offset, maxBytes: 10)
            XCTAssertLessThanOrEqual(page.content.utf8.count, 10)
            XCTAssertEqual(page.totalBytes, text.utf8.count)
            XCTAssertEqual(page.sha256, SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined())
            collected += page.content
            pages += 1
            guard let next = page.nextOffset else { break }
            offset = next
        } while pages < 1_000
        XCTAssertEqual(collected, text)
        // An offset inside a character starts at the next one.
        XCTAssertEqual(try ShannonFolderHostOperations.read(root, relativePath: "notes/旅.md", offset: 1, maxBytes: 3).content, "方")
    }

    func testAReadIsCutSoTheEscapedReportStaysUnderItsCap() throws {
        // 256 KiB of a control character escapes to six bytes each: far over 640 KiB if sent whole.
        try write("escaped.txt", String(repeating: "\u{01}", count: ShannonFolderHostLimits.readBytes))
        let page = try ShannonFolderHostOperations.read(try root(), relativePath: "escaped.txt", offset: 0, maxBytes: ShannonFolderHostLimits.readBytes)
        let body = try ShannonFolderHostReport.done(.read(page)).body(scopeKey: "owner")
        XCTAssertLessThanOrEqual(body.count, ShannonFolderHostLimits.reportBodyBytes)
        XCTAssertGreaterThan(page.content.utf8.count, 0)
        XCTAssertEqual(page.nextOffset, page.content.utf8.count)
    }

    func testSearchStopsAtItsFileCountAndItsTwoSeconds() throws {
        for index in 0..<520 { try write(String(format: "many/%03d.md", index), "line \(index)\n") }
        try write("notes/駅.md", "一行目\n夕方の駅\n駅の光\n駅前\n駅の四つ目\n")
        let root = try root()
        let byFiles = try ShannonFolderHostOperations.search(root, query: "nothing-matches", relativePath: "many", limit: 50)
        XCTAssertEqual(byFiles.filesScanned, ShannonFolderHostLimits.searchFiles)
        XCTAssertTrue(byFiles.truncated)
        // At most three hits a file, one a line, with the line number; NFKC and case are ignored.
        let station = try ShannonFolderHostOperations.search(root, query: "駅", relativePath: "notes", limit: 50)
        XCTAssertEqual(station.hits.map(\.line), [nil, 2, 3])
        XCTAssertEqual(station.hits.first?.path, "notes/駅.md")
        XCTAssertEqual(try ShannonFolderHostOperations.search(root, query: "ＬＩＮＥ 7", relativePath: "many", limit: 1).hits.count, 1)
        // The clock: every look at it is a second later.
        var tick = Date(timeIntervalSince1970: 0)
        let timed = try ShannonFolderHostOperations.search(root, query: "line", relativePath: "many", limit: 50) {
            tick = tick.addingTimeInterval(1)
            return tick
        }
        XCTAssertTrue(timed.truncated)
        XCTAssertLessThan(timed.filesScanned, 3)
    }

    // MARK: The bookmark

    func testAStaleBookmarkIsMadeAgainAndAFailedOneLeavesTheFolderNotConfigured() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-folder-\(UUID().uuidString)"))
        let fake = FakeBookmarks(folder: folder)
        let store = ShannonFolderBookmarkStore(defaults: defaults, bookmarking: fake)
        XCTAssertEqual(store.restore(), .none)
        try store.save(folder)
        fake.stale = true
        XCTAssertEqual(store.restore(), .folder(folder))
        XCTAssertEqual(defaults.data(forKey: ShannonFolderBookmarkStore.defaultsKey), Data("bookmark-2".utf8))
        fake.fails = true
        XCTAssertEqual(store.restore(), .failed)
        XCTAssertTrue(store.isChosen)

        let worker = ShannonFolderHostWorker()
        let step = ShannonFolderHostStep(id: UUID().uuidString.lowercased(), operation: "list", relativePath: "")
        let unconfigured = await worker.perform(step, stopped: false)
        XCTAssertEqual(unconfigured, .refused(.init(.folderNotConfigured)))
        await worker.setFolder(folder)
        let listed = await worker.perform(step, stopped: false)
        XCTAssertEqual(listed.outcome, "done")
        let written = await worker.perform(ShannonFolderHostStep(id: step.id, operation: "create", relativePath: "a.md"), stopped: false)
        XCTAssertEqual(written, .refused(.init(.unsupportedOperation)))
    }

    @MainActor
    func testChoosingTheSameFolderAgainKeepsItsAccessBalanced() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-folder-\(UUID().uuidString)"))
        let fake = FakeBookmarks(folder: folder)
        let model = ShannonFolderHostModel(bookmarks: ShannonFolderBookmarkStore(defaults: defaults, bookmarking: fake), defaults: defaults,
                                           log: ShannonFolderHostActivityLog(fileURL: base.appendingPathComponent("log.jsonl")))
        model.choose(folder)
        model.choose(folder)
        model.choose(folder)
        XCTAssertEqual(model.folder, folder)
        XCTAssertEqual(fake.starts - fake.stops, 1)
        model.stopUsing()
        XCTAssertEqual(fake.starts, fake.stops)
        XCTAssertFalse(model.isChosen)
    }

    // MARK: The loop and the wire

    func testTheLocalStopClaimsWithLocalStopAndRefusesAStepThatArrivesAsItTurnsOn() async throws {
        let transport = FakeTransport()
        let worker = ShannonFolderHostWorker()
        await worker.setFolder(folder)
        let runner = ShannonFolderHostRunner(transport: transport, worker: worker)

        transport.step = nil
        let stopped = await runner.turn { true }
        XCTAssertEqual(stopped.link, .connected(host: "owner-mac", label: "Mac", stopped: true))
        XCTAssertEqual(stopped.delay, ShannonFolderHostWire.stoppedClaimSeconds)
        XCTAssertEqual(transport.claims.last, ShannonFolderHostClaimRequest(scopeKey: "owner", host: "owner-mac", localStop: true))
        XCTAssertEqual(transport.claims.last?.waitSeconds, 0)

        // An empty claim that came back at once is not repeated at once; one the server held is.
        let quick = await runner.turn { false }
        XCTAssertEqual(quick.delay, ShannonFolderHostWire.shortestClaimSeconds, accuracy: 0.2)
        let clock = TickingClock(step: 25)
        let held = ShannonFolderHostRunner(transport: transport, worker: worker, now: { clock.next() })
        let afterHold = await held.turn { false }
        XCTAssertEqual(afterHold.delay, 0)

        // The step was handed out just as the owner pressed the stop switch: it is not run.
        transport.step = ShannonFolderHostStep(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21", operation: "list", relativePath: "")
        let answers = Answers([false, true])
        let caught = await runner.turn { await answers.next() }
        XCTAssertEqual(transport.claims.last?.waitSeconds, 25)
        XCTAssertEqual(transport.reports.last?.1, .refused(.init(.stoppedLocally)))
        XCTAssertEqual(caught.entry?.code, "stopped_locally")
        XCTAssertNil(caught.entry?.count)

        transport.failure = ShannonFolderHostTransportError.notBound
        let unbound = await runner.turn { false }
        XCTAssertEqual(unbound.link, .notRegistered)
        // A server without the binding route (404) is not asked again every few seconds.
        transport.failure = ShannonFolderHostTransportError.rejected(status: 404)
        let older = await runner.turn { false }
        XCTAssertEqual(older.link, .offline)
        XCTAssertEqual(older.delay, 60)
    }

    func testTheWireIsWhatTheServerContractTestsSendAndAccept() async throws {
        FolderHostURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FolderHostURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let baseURL = URL(string: "https://example.test/companion")!
        let api = ShannonAPIClient(baseURL: baseURL, connectionStore: FolderHostConnectionStore(baseURL: baseURL))
        let client = ShannonFolderHostClaimClient(api: api, session: session)

        FolderHostURLProtocol.responses = [(200, #"{"host":"owner-mac","label":"Mac"}"#)]
        let binding = try await client.binding()
        XCTAssertEqual(binding, ShannonFolderHostBinding(host: "owner-mac", label: "Mac"))
        XCTAssertEqual(FolderHostURLProtocol.seen.last?.line, "GET /companion/v1/autonomy/host-steps/binding?scopeKey=owner-scope Bearer device-token")

        // The step of `hostFolderOperations.test.ts`.
        FolderHostURLProtocol.responses = [(200, #"{"step":{"id":"8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21","operation":"read","relativePath":"notes/旅の計画.md","offset":0,"maxBytes":262144,"expiresAt":"2026-10-05T03:00:15.000Z"}}"#)]
        let step = try await client.claim(ShannonFolderHostClaimRequest(scopeKey: "owner", host: "owner-mac", localStop: false))
        XCTAssertEqual(step, ShannonFolderHostStep(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21", operation: "read", relativePath: "notes/旅の計画.md",
                                                   offset: 0, maxBytes: 262_144, expiresAt: "2026-10-05T03:00:15.000Z"))
        let claim = try JSONSerialization.jsonObject(with: FolderHostURLProtocol.seen.last!.body) as! [String: Any]
        XCTAssertEqual(Set(claim.keys), ["scopeKey", "host", "protocol", "operations", "waitSeconds", "localStop"])
        XCTAssertEqual(claim["scopeKey"] as? String, "owner-scope")
        XCTAssertEqual(claim["protocol"] as? Int, 2)
        XCTAssertEqual(claim["operations"] as? [String], ["list", "read", "search"])
        XCTAssertEqual(claim["waitSeconds"] as? Int, 25)
        XCTAssertEqual(claim["localStop"] as? Bool, false)

        // Reports: only the fields of the contract, `nextOffset` and `line` sent as null, never left out.
        try write("notes/旅の計画.md", "ファイルの中身")
        let worker = ShannonFolderHostWorker()
        await worker.setFolder(folder)
        let read = await worker.perform(try XCTUnwrap(step), stopped: false)
        FolderHostURLProtocol.responses = [(200, #"{"id":"x","status":"done","recorded":true}"#)]
        try await client.report(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21", read)
        let sent = try JSONSerialization.jsonObject(with: FolderHostURLProtocol.seen.last!.body) as! [String: Any]
        XCTAssertEqual(FolderHostURLProtocol.seen.last?.line, "POST /companion/v1/autonomy/host-steps/8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21/report Bearer device-token")
        XCTAssertEqual(Set(sent.keys), ["scopeKey", "outcome", "result"])
        let result = try XCTUnwrap(sent["result"] as? [String: Any])
        XCTAssertEqual(Set(result.keys), ["content", "offset", "nextOffset", "totalBytes", "sha256", "modifiedAt"])
        XCTAssertTrue(result["nextOffset"] is NSNull)
        XCTAssertEqual(result["content"] as? String, "ファイルの中身")
        XCTAssertNotNil(ISO8601DateFormatter.withFractionalSeconds.date(from: result["modifiedAt"] as? String ?? ""))

        let search = ShannonFolderHostReport.done(.search(.init(hits: [.init(path: "a.md", line: nil, snippet: "a")], filesScanned: 1, truncated: false)))
        let searchBody = try JSONSerialization.jsonObject(with: search.body(scopeKey: "owner")) as! [String: Any]
        let hit = try XCTUnwrap(((searchBody["result"] as? [String: Any])?["hits"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(hit.keys), ["path", "line", "snippet"])
        XCTAssertTrue(hit["line"] is NSNull)
        let refused = try JSONSerialization.jsonObject(with: ShannonFolderHostReport.refused(.init(.notText)).body(scopeKey: "owner")) as! [String: Any]
        XCTAssertEqual(refused as NSDictionary, ["scopeKey": "owner", "outcome": "refused", "code": "not_text"] as NSDictionary)
        let listed = try JSONSerialization.jsonObject(with: ShannonFolderHostReport.done(.list(.init(entries: [
            .init(path: "notes", type: "folder", bytes: nil, modifiedAt: "2026-10-04T00:00:00.000Z"),
        ], truncated: false))).body(scopeKey: "owner")) as! [String: Any]
        let entry = try XCTUnwrap(((listed["result"] as? [String: Any])?["entries"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(entry.keys), ["path", "type", "modifiedAt"])

        // 403 HOST_NOT_BOUND and 401 PAIRING_REQUIRED.
        FolderHostURLProtocol.responses = [(403, #"{"error":"HOST_NOT_BOUND"}"#)]
        do { _ = try await client.claim(.init(scopeKey: "owner", host: "owner-mac", localStop: false)); XCTFail("403 must throw") } catch {
            XCTAssertEqual(error as? ShannonFolderHostTransportError, .notBound)
        }
        FolderHostURLProtocol.responses = [(401, #"{"error":"PAIRING_REQUIRED"}"#)]
        do { _ = try await client.binding(); XCTFail("401 must throw") } catch {
            XCTAssertEqual(error as? ShannonFolderHostTransportError, .notPaired)
        }
    }
}

// MARK: Fakes

private final class FakeBookmarks: ShannonFolderBookmarking, @unchecked Sendable {
    let folder: URL
    var stale = false
    var fails = false
    private var made = 0

    init(folder: URL) { self.folder = folder }

    func bookmark(for folder: URL) throws -> Data {
        made += 1
        return Data("bookmark-\(made)".utf8)
    }

    func resolve(_ data: Data) throws -> (folder: URL, isStale: Bool) {
        if fails { throw CocoaError(.fileReadCorruptFile) }
        return (folder, stale)
    }

    private(set) var starts = 0
    private(set) var stops = 0
    func startAccessing(_ folder: URL) -> Bool { starts += 1; return true }
    func stopAccessing(_ folder: URL) { stops += 1 }
}

/// Each look is `step` seconds after the one before.
private final class TickingClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 0)
    private let step: TimeInterval
    init(step: TimeInterval) { self.step = step }
    func next() -> Date {
        lock.lock()
        defer { lock.unlock() }
        current = current.addingTimeInterval(step)
        return current
    }
}

private actor Answers {
    private var values: [Bool]
    init(_ values: [Bool]) { self.values = values }
    func next() -> Bool { values.isEmpty ? true : values.removeFirst() }
}

private final class FakeTransport: ShannonFolderHostTransport, @unchecked Sendable {
    var step: ShannonFolderHostStep?
    var failure: Error?
    private(set) var claims: [ShannonFolderHostClaimRequest] = []
    private(set) var reports: [(String, ShannonFolderHostReport)] = []

    func binding() async throws -> ShannonFolderHostBinding {
        if let failure { throw failure }
        return .init(host: "owner-mac", label: "Mac")
    }

    func claim(_ request: ShannonFolderHostClaimRequest) async throws -> ShannonFolderHostStep? {
        if let failure { throw failure }
        claims.append(request)
        return step
    }

    func report(id: String, _ report: ShannonFolderHostReport) async throws {
        reports.append((id, report))
    }
}

private struct FolderHostConnectionStore: ShannonConnectionStoreProtocol {
    let baseURL: URL
    func load() throws -> ShannonConnectionCredential? {
        ShannonConnectionCredential(baseURL: baseURL, token: "device-token", deviceID: "fedcba9876543210", scopeKey: "owner-scope",
                                    displayName: "このMac", expiresAt: Date(timeIntervalSinceNow: 3_600))
    }
    func save(_ credential: ShannonConnectionCredential) throws {}
    func delete() throws {}
}

private final class FolderHostURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var seen: [(line: String, body: Data)] = []
    nonisolated(unsafe) static var responses: [(Int, String)] = []

    static func reset() {
        seen = []
        responses = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        let query = url.query.map { "?\($0)" } ?? ""
        let authorization = (request.value(forHTTPHeaderField: "authorization") ?? "-")
        Self.seen.append(("\(request.httpMethod ?? "GET") \(url.path)\(query) \(authorization)", body))
        let (status, text) = Self.responses.isEmpty ? (500, "{}") : Self.responses.removeFirst()
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension ISO8601DateFormatter {
    static var withFractionalSeconds: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
#endif
