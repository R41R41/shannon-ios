import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonCalendarSharingModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName = ""
    private let clock = TestClock()

    override func setUp() async throws {
        suiteName = "calendar-sharing-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func makeModel(
        client: FakeCalendarClient?,
        source: FakeCalendarSource,
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { _ in }
    ) -> ShannonCalendarSharingModel {
        ShannonCalendarSharingModel(
            client: client,
            source: source,
            defaults: defaults,
            now: { [clock] in clock.now },
            timeZone: { TimeZone(identifier: "Asia/Tokyo")! },
            sleep: sleep
        )
    }

    // MARK: Off by default

    func testIsOffByDefaultAndReadsAndSendsNothingWhileOff() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        XCTAssertFalse(model.isEnabled)
        XCTAssertEqual(model.status, .off)
        for trigger in [ShannonCalendarSyncTrigger.launch, .foreground, .storeChanged, .periodic] {
            await model.sync(trigger)
        }
        await model.calendarDidChange()
        XCTAssertEqual(source.readCount, 0)
        XCTAssertEqual(source.accessRequests, 0)
        XCTAssertEqual(client.calls, [])
    }

    // MARK: Switching on

    func testSwitchingOnAsksForAccessThenSendsTheSnapshot() async throws {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .notDetermined, grantsOnRequest: true)
        source.events = [ShannonCalendarSourceEvent(
            identifier: "E1", title: "歯医者", start: clock.now.addingTimeInterval(3_600), end: clock.now.addingTimeInterval(7_200)
        )]
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        XCTAssertEqual(source.accessRequests, 1)
        XCTAssertTrue(model.isEnabled)
        XCTAssertEqual(client.calls, ["PUT"])
        let sent = try JSONDecoder().decode(ShannonCalendarUpcomingRequestDTO.self, from: try XCTUnwrap(client.bodies.first))
        XCTAssertEqual(sent.scopeKey, "owner-a")
        XCTAssertEqual(sent.events.map(\.title), ["歯医者"])
        // A day back (today's earlier events) and 29 days ahead: 30 days, inside the server's 31.
        XCTAssertEqual(source.lastWindow?.start, clock.now.addingTimeInterval(-86_400))
        XCTAssertEqual(source.lastWindow?.end, clock.now.addingTimeInterval(29 * 86_400))
        XCTAssertEqual(model.status, .sent(at: clock.now, count: 1))
    }

    func testStateSurvivesARelaunch() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        await makeModel(client: client, source: source).setEnabled(true)
        let relaunched = makeModel(client: client, source: source)
        XCTAssertTrue(relaunched.isEnabled)
        XCTAssertEqual(relaunched.status, .sent(at: clock.now, count: 0))
    }

    func testDeniedAccessKeepsTheSwitchOnButReadsNothing() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .notDetermined, grantsOnRequest: false)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        XCTAssertTrue(model.isEnabled)
        XCTAssertEqual(model.status, .needsPermission)
        XCTAssertEqual(source.readCount, 0)
        XCTAssertEqual(client.calls, [])
        let opensSettings = await model.resolvePermission()
        XCTAssertTrue(opensSettings)
        // The owner grants access in the system Settings and comes back.
        source.setAuthorization(.granted)
        await model.sync(.foreground)
        XCTAssertEqual(client.calls, ["PUT"])
    }

    func testAnUnpairedDeviceCannotSwitchOn() async {
        let client = FakeCalendarClient(identity: nil)
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        XCTAssertFalse(model.isEnabled)
        XCTAssertEqual(model.status, .notPaired)
        XCTAssertEqual(source.readCount, 0)
        XCTAssertEqual(source.accessRequests, 0)
        XCTAssertEqual(client.calls, [])
    }

    // MARK: Older server

    func testAServerWithoutTheRouteKeepsTheSwitchOnAndRetriesOnTheNextSync() async {
        let client = FakeCalendarClient()
        client.putResults = [.failure(ShannonAPIError.rejected(status: 404))]
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        XCTAssertTrue(model.isEnabled)
        XCTAssertEqual(model.status, .unsupported)
        clock.advance(120)
        await model.sync(.foreground)
        XCTAssertEqual(client.calls, ["PUT", "PUT"])
        XCTAssertEqual(model.status, .sent(at: clock.now, count: 0))
    }

    func testAFailedUploadKeepsTheLastSentState() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        let firstSent = clock.now
        client.putResults = [.failure(URLError(.notConnectedToInternet))]
        clock.advance(120)
        await model.sync(.foreground)
        XCTAssertTrue(model.isEnabled)
        XCTAssertEqual(model.status, .failed(lastSentAt: firstSent, count: 0))
    }

    // MARK: Switching off

    func testSwitchingOffSendsDeleteAndStopsReading() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        await model.setEnabled(false)
        XCTAssertEqual(client.calls, ["PUT", "DELETE"])
        XCTAssertFalse(model.isEnabled)
        XCTAssertEqual(model.status, .off)
        let reads = source.readCount
        clock.advance(3_600)
        await model.sync(.foreground)
        await model.calendarDidChange()
        XCTAssertEqual(source.readCount, reads)
        XCTAssertEqual(client.calls, ["PUT", "DELETE"])
    }

    func testDeleteFallsBackToAnEmptyPutOn404And405() async throws {
        for status in [404, 405] {
            let client = FakeCalendarClient()
            let source = FakeCalendarSource(authorization: .granted)
            source.events = [ShannonCalendarSourceEvent(
                identifier: "E1", title: "予定", start: clock.now, end: clock.now.addingTimeInterval(60)
            )]
            let model = makeModel(client: client, source: source)
            await model.setEnabled(true)
            let reads = source.readCount
            client.deleteResults = [.failure(ShannonAPIError.rejected(status: status))]
            await model.setEnabled(false)
            XCTAssertEqual(client.calls, ["PUT", "DELETE", "PUT"], "status \(status)")
            let empty = try JSONDecoder().decode(ShannonCalendarUpcomingRequestDTO.self, from: client.bodies[1])
            XCTAssertEqual(empty.events, [])
            XCTAssertEqual(empty.scopeKey, "owner-a")
            XCTAssertEqual(source.readCount, reads, "the empty snapshot must not read the calendar")
            XCTAssertEqual(model.status, .off)
        }
    }

    func testAServerWithNoCalendarRouteAtAllHasNothingToRemove() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        client.deleteResults = [.failure(ShannonAPIError.rejected(status: 404))]
        client.putResults = [.failure(ShannonAPIError.rejected(status: 404))]
        await model.setEnabled(false)
        XCTAssertEqual(client.calls, ["PUT", "DELETE", "PUT"])
        XCTAssertEqual(model.status, .off)
    }

    func testAFailedRemovalStaysPendingAndIsRetriedOnTheNextSync() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        client.deleteResults = [.failure(URLError(.notConnectedToInternet))]
        await model.setEnabled(false)
        XCTAssertFalse(model.isEnabled)
        XCTAssertEqual(model.status, .removalPending)
        let relaunched = makeModel(client: client, source: source)
        XCTAssertEqual(relaunched.status, .removalPending)
        await relaunched.sync(.launch)
        XCTAssertEqual(client.calls, ["PUT", "DELETE", "DELETE"])
        XCTAssertEqual(relaunched.status, .off)
        XCTAssertEqual(source.readCount, 1)
    }

    // MARK: Pairing

    func testUnpairingRemovesTheSnapshotFirstAndTurnsSharingOff() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        await model.removeBeforeUnpairing()
        XCTAssertEqual(client.calls, ["PUT", "DELETE"])
        client.setIdentity(nil)
        clock.advance(3_600)
        await model.sync(.foreground)
        XCTAssertFalse(model.isEnabled)
        XCTAssertEqual(client.calls, ["PUT", "DELETE"])
    }

    func testPairingAgainAsAnotherDeviceRequiresSwitchingOnAgain() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        client.setIdentity(ShannonCalendarSharingIdentity(scopeKey: "guest-b", deviceID: "device-2"))
        clock.advance(3_600)
        let reads = source.readCount
        await model.sync(.foreground)
        XCTAssertFalse(model.isEnabled)
        XCTAssertEqual(model.status, .off)
        XCTAssertEqual(source.readCount, reads)
        XCTAssertEqual(client.calls, ["PUT"])
    }

    // MARK: Throttle and debounce

    func testForegroundAndTimerSyncsAreSpacedOut() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let model = makeModel(client: client, source: source)
        await model.setEnabled(true)
        clock.advance(30)
        await model.sync(.foreground)
        await model.sync(.periodic)
        XCTAssertEqual(client.calls, ["PUT"])
        clock.advance(60)
        await model.sync(.foreground)
        XCTAssertEqual(client.calls, ["PUT", "PUT"])
        clock.advance(10 * 60)
        await model.sync(.periodic)
        XCTAssertEqual(client.calls, ["PUT", "PUT"])
        clock.advance(5 * 60)
        await model.sync(.periodic)
        XCTAssertEqual(client.calls, ["PUT", "PUT", "PUT"])
    }

    func testABurstOfCalendarChangesProducesOneUpload() async {
        let client = FakeCalendarClient()
        let source = FakeCalendarSource(authorization: .granted)
        let pause = SleepGate()
        let model = makeModel(client: client, source: source, sleep: { _ in await pause.wait() })
        await model.setEnabled(true)
        XCTAssertEqual(client.calls, ["PUT"])
        let burst = (0..<3).map { _ in Task { await model.calendarDidChange() } }
        await pause.waitForWaiters(3)
        XCTAssertEqual(client.calls, ["PUT"], "nothing is sent until the burst settles")
        await pause.releaseAll()
        for task in burst { await task.value }
        XCTAssertEqual(client.calls, ["PUT", "PUT"])
    }

    func testDesignPreviewNeverReadsOrSends() async {
        let model = ShannonCalendarSharingModel.designPreview(.sent(at: clock.now, count: 12))
        XCTAssertTrue(model.isEnabled)
        await model.setEnabled(false)
        await model.sync(.launch)
        XCTAssertEqual(model.status, .sent(at: clock.now, count: 12))
        XCTAssertFalse(ShannonCalendarSharingModel.designPreview(.off).isEnabled)
    }

    // MARK: Requests

    func testClientSendsPutAndDeleteWithTheDeviceTokenOnly() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CalendarURLProtocol.self]
        CalendarURLProtocol.reset()
        defer { CalendarURLProtocol.reset() }
        let baseURL = URL(string: "https://shannon.example/companion")!
        let store = CalendarConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: "device-token",
            deviceID: "device-1",
            scopeKey: "owner-a",
            displayName: "iPhone",
            expiresAt: Date().addingTimeInterval(86_400)
        ))
        let session = URLSession(configuration: configuration)
        let client = ShannonAPIClient(baseURL: baseURL, apiToken: "build-token", connectionStore: store, session: session)
        XCTAssertEqual(client.calendarSharingIdentity(), ShannonCalendarSharingIdentity(scopeKey: "owner-a", deviceID: "device-1"))
        let body = try ShannonCalendarSnapshotBuilder.encode(ShannonCalendarSnapshotBuilder.request(
            scopeKey: "owner-a", events: [], now: clock.now, timeZone: .gmt
        ))
        let response = try await client.putUpcomingCalendar(body)
        XCTAssertEqual(response, ShannonCalendarUpcomingResponseDTO(schemaVersion: 1, stored: 3, receivedAt: "2026-10-02T00:00:01.000Z"))
        try await client.deleteUpcomingCalendar()
        XCTAssertEqual(CalendarURLProtocol.seen, [
            "PUT /companion/v1/calendar/upcoming Bearer device-token application/json",
            "DELETE /companion/v1/calendar/upcoming Bearer device-token -",
        ])
        XCTAssertEqual(CalendarURLProtocol.bodies.first, body)

        CalendarURLProtocol.status = 404
        do {
            _ = try await client.putUpcomingCalendar(body)
            XCTFail("404 must surface as a rejection")
        } catch {
            XCTAssertEqual(error as? ShannonAPIError, .rejected(status: 404))
        }
        do {
            try await client.deleteUpcomingCalendar()
            XCTFail("404 must surface as a rejection")
        } catch {
            XCTAssertEqual(error as? ShannonAPIError, .rejected(status: 404))
        }

        let unpaired = ShannonAPIClient(baseURL: baseURL, apiToken: "build-token", session: session)
        XCTAssertNil(unpaired.calendarSharingIdentity())
        let before = CalendarURLProtocol.seen.count
        do {
            _ = try await unpaired.putUpcomingCalendar(body)
            XCTFail("the build-time token must never send a schedule")
        } catch {
            XCTAssertEqual(error as? ShannonCalendarSharingError, .notPaired)
        }
        XCTAssertEqual(CalendarURLProtocol.seen.count, before)
    }
}

// MARK: Fixtures

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_790_899_200)

    var now: Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

private final class FakeCalendarSource: ShannonCalendarEventSource, @unchecked Sendable {
    private let lock = NSLock()
    private var status: ShannonCalendarAuthorization
    private let grantsOnRequest: Bool
    private var storedEvents: [ShannonCalendarSourceEvent] = []
    private var reads = 0
    private var requests = 0
    private var window: (start: Date, end: Date)?

    init(authorization: ShannonCalendarAuthorization, grantsOnRequest: Bool = false) {
        status = authorization
        self.grantsOnRequest = grantsOnRequest
    }

    var events: [ShannonCalendarSourceEvent] {
        get { lock.withLock { storedEvents } }
        set { lock.withLock { storedEvents = newValue } }
    }
    var readCount: Int { lock.withLock { reads } }
    var accessRequests: Int { lock.withLock { requests } }
    var lastWindow: (start: Date, end: Date)? { lock.withLock { window } }
    func setAuthorization(_ value: ShannonCalendarAuthorization) { lock.withLock { status = value } }

    func authorization() -> ShannonCalendarAuthorization { lock.withLock { status } }

    func requestAccess() async -> Bool {
        lock.withLock {
            requests += 1
            status = grantsOnRequest ? .granted : .denied
            return grantsOnRequest
        }
    }

    func events(from start: Date, to end: Date) async -> [ShannonCalendarSourceEvent] {
        lock.withLock {
            reads += 1
            window = (start, end)
            return storedEvents
        }
    }

    func changes() -> AsyncStream<Void> { AsyncStream { $0.finish() } }
}

private final class FakeCalendarClient: ShannonCalendarServing, @unchecked Sendable {
    private let lock = NSLock()
    private var identity: ShannonCalendarSharingIdentity?
    private var recorded: [String] = []
    private var recordedBodies: [Data] = []
    private var scriptedPuts: [Result<Void, Error>] = []
    private var scriptedDeletes: [Result<Void, Error>] = []

    init(identity: ShannonCalendarSharingIdentity? = ShannonCalendarSharingIdentity(scopeKey: "owner-a", deviceID: "device-1")) {
        self.identity = identity
    }

    var calls: [String] { lock.withLock { recorded } }
    var bodies: [Data] { lock.withLock { recordedBodies } }
    /// Results for the next calls, in order; afterwards calls succeed.
    var putResults: [Result<Void, Error>] {
        get { lock.withLock { scriptedPuts } }
        set { lock.withLock { scriptedPuts = newValue } }
    }
    var deleteResults: [Result<Void, Error>] {
        get { lock.withLock { scriptedDeletes } }
        set { lock.withLock { scriptedDeletes = newValue } }
    }
    func setIdentity(_ value: ShannonCalendarSharingIdentity?) { lock.withLock { identity = value } }

    func calendarSharingIdentity() -> ShannonCalendarSharingIdentity? { lock.withLock { identity } }

    func putUpcomingCalendar(_ body: Data) async throws -> ShannonCalendarUpcomingResponseDTO {
        let result: Result<Void, Error> = lock.withLock {
            recorded.append("PUT")
            recordedBodies.append(body)
            return scriptedPuts.isEmpty ? .success(()) : scriptedPuts.removeFirst()
        }
        try result.get()
        let stored = try JSONDecoder().decode(ShannonCalendarUpcomingRequestDTO.self, from: body).events.count
        return ShannonCalendarUpcomingResponseDTO(stored: stored, receivedAt: "2026-10-02T00:00:01.000Z")
    }

    func deleteUpcomingCalendar() async throws {
        let result: Result<Void, Error> = lock.withLock {
            recorded.append("DELETE")
            return scriptedDeletes.isEmpty ? .success(()) : scriptedDeletes.removeFirst()
        }
        try result.get()
    }
}

/// A sleep that only returns when the test releases it.
private actor SleepGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var watchers: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
            let ready = watchers.filter { $0.count <= waiters.count }
            watchers.removeAll { $0.count <= waiters.count }
            ready.forEach { $0.continuation.resume() }
        }
    }

    func waitForWaiters(_ count: Int) async {
        guard waiters.count < count else { return }
        await withCheckedContinuation { watchers.append((count, $0)) }
    }

    func releaseAll() {
        let current = waiters
        waiters = []
        current.forEach { $0.resume() }
    }
}

private struct CalendarConnectionStore: ShannonConnectionStoreProtocol {
    let credential: ShannonConnectionCredential?
    func load() throws -> ShannonConnectionCredential? { credential }
    func save(_ credential: ShannonConnectionCredential) throws {}
    func delete() throws {}
}

private final class CalendarURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var seen: [String] = []
    nonisolated(unsafe) static var bodies: [Data] = []
    nonisolated(unsafe) static var status = 200

    static func reset() {
        seen = []
        bodies = []
        status = 200
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let method = request.httpMethod ?? "GET"
        let authorization = request.value(forHTTPHeaderField: "authorization") ?? "-"
        let contentType = request.value(forHTTPHeaderField: "content-type") ?? "-"
        Self.seen.append("\(method) \(url.path) \(authorization) \(contentType)")
        if method == "PUT" {
            var data = request.httpBody ?? Data()
            if data.isEmpty, let stream = request.httpBodyStream {
                stream.open()
                var buffer = [UInt8](repeating: 0, count: 4_096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    data.append(buffer, count: count)
                }
                stream.close()
            }
            Self.bodies.append(data)
        }
        let body = #"{"schemaVersion":1,"stored":3,"receivedAt":"2026-10-02T00:00:01.000Z"}"#
        let response = HTTPURLResponse(url: url, statusCode: Self.status, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
