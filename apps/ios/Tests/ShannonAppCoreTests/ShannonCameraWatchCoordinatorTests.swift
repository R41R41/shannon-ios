import Foundation
import XCTest
@testable import ShannonAppCore

/// The coordinator of watching with a synthetic camera, system and server: when the camera opens and closes, what is sent,
/// and what each answer of the worker does.
@MainActor
final class ShannonCameraWatchCoordinatorTests: XCTestCase {
    private var facts = WatchFacts()
    private var camera = WatchCamera()
    private var server = WatchServer()
    private var monitoring = 0

    private func makeWatch() -> ShannonCameraWatchCoordinator {
        let facts = facts
        let environment = ShannonCameraWatchEnvironment(
            system: { facts.system }, settingOn: { facts.settingOn }, permission: { facts.permission }, camera: camera,
            startMonitoring: { [weak self] _, _ in self?.monitoring += 1 }, stopMonitoring: { [weak self] in self?.monitoring -= 1 })
        return ShannonCameraWatchCoordinator(client: server, environment: environment)
    }

    /// Lets the coordinator's tasks run until `condition` holds (or fails after a while).
    private func waitFor(_ label: String, _ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition(), label)
    }

    private func watching() async -> ShannonCameraWatchCoordinator {
        let watch = makeWatch()
        watch.register(sign: UUID())
        await waitFor("watching after the server allowed it") { watch.isWatching }
        return watch
    }

    private func shot(_ reason: ShannonVisionGateReason = .firstFrame) -> ShannonCameraWatchEvent {
        .shot(ShannonCameraWatchShot(frame: .init(jpeg: Data([0xFF, 0xD8, 0xFF, 0xE0]), width: 512, height: 384),
            capturedAt: Date(), reason: reason, difference: nil, personCount: 1))
    }

    func testTheCameraOpensOnlyWithASignAndAfterTheServerAllowsIt() async {
        let watch = makeWatch()
        watch.reevaluate()
        XCTAssertFalse(watch.isWatching, "no surface shows the sign")
        XCTAssertEqual(server.statusReads, 0)
        let sign = UUID()
        watch.register(sign: sign)
        XCTAssertEqual(monitoring, 1)
        XCTAssertFalse(watch.isWatching, "the server is asked first")
        await waitFor("opened") { watch.isWatching }
        XCTAssertEqual(server.statusReads, 1)
        XCTAssertEqual(camera.starts, 1)
        watch.unregister(sign: sign)
        XCTAssertFalse(watch.isWatching)
        XCTAssertEqual(camera.stops, 1)
        XCTAssertEqual(monitoring, 0)
    }

    func testTheServerSayingNoKeepsTheCameraClosed() async {
        server.status = .init(watchAllowed: false, reason: .audience, degrade: 0, limits: WatchServer.limits)
        let watch = makeWatch()
        watch.register(sign: UUID())
        await waitFor("asked") { self.server.statusReads == 1 }
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(watch.isWatching)
        XCTAssertEqual(camera.starts, 0)
    }

    func testEachSystemChangeClosesTheCameraAtOnce() async {
        let changes: [(String, (WatchFacts) -> Void)] = [
            ("background", { $0.system.appInFront = false }),
            ("locked", { $0.system.unlocked = false }),
            ("low power", { $0.system.lowPowerMode = true }),
            ("thermal", { $0.system.thermalHeavy = true }),
            ("setting off", { $0.settingOn = false }),
            ("permission revoked", { $0.permission = .denied }),
        ]
        for (label, change) in changes {
            facts = WatchFacts()
            camera = WatchCamera()
            server = WatchServer()
            let watch = await watching()
            change(facts)
            watch.reevaluate()
            XCTAssertFalse(watch.isWatching, label)
            XCTAssertEqual(camera.stops, 1, label)
        }
    }

    func testOthersOnTheDeviceCloseTheCamera() async {
        let watch = await watching()
        watch.setOthersPresent(true)
        XCTAssertFalse(watch.isWatching)
        XCTAssertEqual(camera.stops, 1)
    }

    func testAFrameIsSentWithItsSessionAndAReactionIsShown() async throws {
        let watch = await watching()
        server.frameResults = [.reply(WatchServer.reply(reaction: .smile))]
        camera.emit(shot())
        await waitFor("sent") { self.server.frames.count == 1 }
        let sent = try XCTUnwrap(server.frames.first)
        XCTAssertEqual(sent.frame.sessionId, watch.sessionId)
        XCTAssertEqual(sent.frame.generation, 1)
        XCTAssertEqual(sent.frame.gate?.reason, .firstFrame)
        XCTAssertEqual(sent.frame.encoding.byteLength, 4)
        XCTAssertEqual(sent.jpeg, Data([0xFF, 0xD8, 0xFF, 0xE0]))
        XCTAssertNotNil(watch.lookedCue, "「いま見ました」")
        await waitFor("reaction") { watch.reaction != nil }
        XCTAssertEqual(watch.reaction?.expression, .joyful)
        XCTAssertEqual(camera.settles.count, 1)
        XCTAssertTrue(watch.isWatching)
    }

    func testTheWorkerStoppingWatchingClosesTheCameraAndSaysWhy() async {
        let watch = await watching()
        server.frameResults = [.reply(WatchServer.reply(watch: .stop, stopReason: .audience))]
        camera.emit(shot())
        await waitFor("stopped") { !watch.isWatching }
        XCTAssertEqual(watch.notice, "ほかの人がいるので、見るのを止めました")
        XCTAssertEqual(watch.server, .refused(.audience))
    }

    func testAWorkerThatIsDownStopsWatching() async {
        let watch = await watching()
        server.frameResults = [.workerDown]
        camera.emit(shot())
        await waitFor("stopped") { !watch.isWatching }
        XCTAssertEqual(watch.server, .unreachable)
        XCTAssertEqual(camera.stops, 1)
    }

    func testNotNowWaitsAndKeepsWatching() async throws {
        let watch = await watching()
        let until = Date().addingTimeInterval(5)
        server.frameResults = [.notNow(until: until)]
        camera.emit(shot())
        await waitFor("settled") { self.camera.settles.count == 1 }
        XCTAssertEqual(try XCTUnwrap(camera.settles.first ?? nil), until)
        XCTAssertTrue(watch.isWatching)
    }

    func testTwoPeopleStopWatchingAndReportPresence() async {
        let watch = await watching()
        camera.emit(.othersSeen(personCount: 2))
        await waitFor("stopped") { !watch.isWatching }
        await waitFor("presence") { self.server.presences == [2] }
        XCTAssertEqual(watch.notice, "ほかの人が映ったので、見るのを止めました")
        // It stays stopped while the app stays open, whatever the server says.
        watch.reevaluate()
        XCTAssertFalse(watch.isWatching)
    }

    func testAFrameFromAClosedCameraIsNotSent() async {
        let watch = await watching()
        facts.system.appInFront = false
        camera.emit(shot())
        watch.reevaluate()
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(server.frames.isEmpty)
    }

    func testTheOwnersStopHoldsUntilResumeOrTheSettingIsSwitchedBackOn() async {
        let watch = await watching()
        watch.stopByOwner()
        XCTAssertFalse(watch.isWatching)
        XCTAssertTrue(watch.stoppedByOwner)
        watch.reevaluate()
        XCTAssertFalse(watch.isWatching)
        watch.resumeByOwner()
        await waitFor("watching again") { watch.isWatching }
        XCTAssertEqual(server.statusReads, 2, "the server is asked again")
        XCTAssertEqual(watch.generation, 1, "a new session starts at generation 1")

        watch.stopByOwner()
        facts.settingOn = false
        watch.reevaluate()
        facts.settingOn = true
        watch.reevaluate()
        XCTAssertFalse(watch.stoppedByOwner)
        await waitFor("watching after the switch") { watch.isWatching }
    }

    func testAOneShotLookTakesTheCameraAndGivesItBack() async {
        let watch = await watching()
        let firstSession = watch.sessionId
        await watch.yieldCamera(true)
        XCTAssertFalse(watch.isWatching)
        XCTAssertEqual(camera.stops, 1)
        await watch.yieldCamera(false)
        XCTAssertTrue(watch.isWatching)
        XCTAssertEqual(watch.sessionId, firstSession)
        XCTAssertEqual(watch.generation, 2, "the generation moves on with each restart")
    }
}

private final class WatchFacts: @unchecked Sendable {
    var system = ShannonCameraWatchSystemFacts(appInFront: true, unlocked: true, lowPowerMode: false, thermalHeavy: false)
    var settingOn = true
    var permission = ShannonMediaPermission.granted
}

private final class WatchCamera: ShannonCameraWatchCapturing, @unchecked Sendable {
    private let lock = NSLock()
    private var events: (@Sendable (ShannonCameraWatchEvent) -> Void)?
    private var counts = (starts: 0, stops: 0)
    private var settled: [Date?] = []
    var starts: Int { lock.withLock { counts.starts } }
    var stops: Int { lock.withLock { counts.stops } }
    var settles: [Date?] { lock.withLock { settled } }

    func start(limits: ShannonCameraWatchLimits, events: @escaping @Sendable (ShannonCameraWatchEvent) -> Void) {
        lock.withLock {
            counts.starts += 1
            self.events = events
        }
    }

    func stop() { lock.withLock { counts.stops += 1 } }
    func waitUntilIdle() async {}
    func settle(notBefore: Date?) { lock.withLock { settled.append(notBefore) } }
    func emit(_ event: ShannonCameraWatchEvent) { lock.withLock { events }?(event) }
}

private final class WatchServer: ShannonVisionServing, @unchecked Sendable {
    static let limits = ShannonVisionStatus.Limits(judgeFramesPerSecond: 2, sendIntervalMs: 2000, longSide: 512, frameBytes: 200_000, ttlMs: 4000)

    static func reply(
        watch: ShannonVisionFrameReply.Watch = .continue, stopReason: ShannonVisionStopReason? = nil, reaction: ShannonVisionReaction? = nil
    ) -> ShannonVisionFrameReply {
        ShannonVisionFrameReply(schema: "vision.frame.reply.v1", frameId: "f", watch: watch, stopReason: stopReason,
            outcome: reaction == nil ? .quiet : .chosen, candidateId: reaction.map { "react:\($0.rawValue)" }, reaction: reaction,
            degrade: 0, nextFrameNotBefore: "2026-10-14T09:00:02.000Z")
    }

    private let lock = NSLock()
    private var reads = 0
    private var sent: [(frame: ShannonVisionFrame, jpeg: Data)] = []
    private var seen: [Int] = []
    private var answers: [ShannonVisionFrameResult] = []
    private var allowed = ShannonVisionStatus(watchAllowed: true, reason: nil, degrade: 0, limits: WatchServer.limits)
    var statusReads: Int { lock.withLock { reads } }
    var frames: [(frame: ShannonVisionFrame, jpeg: Data)] { lock.withLock { sent } }
    var presences: [Int] { lock.withLock { seen } }
    var frameResults: [ShannonVisionFrameResult] {
        get { lock.withLock { answers } }
        set { lock.withLock { answers = newValue } }
    }
    var status: ShannonVisionStatus {
        get { lock.withLock { allowed } }
        set { lock.withLock { allowed = newValue } }
    }

    var visionDeviceId: String? { "device-owner-iphone" }

    func visionStatus() async throws -> ShannonVisionStatus {
        lock.withLock {
            reads += 1
            return allowed
        }
    }

    func sendVisionFrame(_ frame: ShannonVisionFrame, jpeg: Data) async -> ShannonVisionFrameResult {
        lock.withLock {
            sent.append((frame, jpeg))
            return answers.isEmpty ? .reply(Self.reply()) : answers.removeFirst()
        }
    }

    func reportVisionPresence(personCount: Int, at: Date) async throws {
        lock.withLock { seen.append(personCount) }
    }
}
