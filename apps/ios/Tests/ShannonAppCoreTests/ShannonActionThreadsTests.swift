import XCTest
@testable import ShannonAppCore

private actor ThreadClient: ShannonActionThreadsServing {
    var state = "running"
    var serverOthers = false
    var sends = 0
    var reportAge: TimeInterval = 0
    var heldRead: CheckedContinuation<ShannonActionThreadsDTO, any Error>?
    var holdNextRead = false
    var readFailure: ShannonAPIError?
    var losesControlAnswer = false
    func configure(hold: Bool = false, absent: Bool = false, others: Bool = false, losesAnswer: Bool = false, age: TimeInterval = 0) {
        reportAge = age
        serverOthers = others; holdNextRead = hold; readFailure = absent ? .rejected(status: 404) : nil; losesControlAnswer = losesAnswer
    }
    func answer() -> ShannonActionThreadsDTO {
        .init(availability: "ready", generatedAt: Date().addingTimeInterval(-reportAge).formatted(.iso8601), count: ["running", "queued", "waiting", "stopping"].contains(state) ? 1 : 0,
              threads: [.init(id: "one", kind: "ownTime", title: "Private title", origin: "own_time", state: state,
                              progress: nil, result: nil, updatedAt: Date().formatted(.iso8601), failures: 0, canResume: state == "cancelled")], othersPresent: serverOthers)
    }
    func loadActionThreads(scopeKey: String, othersPresent: Bool) async throws -> ShannonActionThreadsDTO {
        if let readFailure { throw readFailure }
        if holdNextRead { holdNextRead = false; return try await withCheckedThrowingContinuation { heldRead = $0 } }
        return answer()
    }
    func controlActionThread(scopeKey: String, id: String?, resume: Bool, requestID: String) async throws -> ShannonActionThreadsDTO {
        sends += 1; state = resume ? "queued" : "stopping"
        if losesControlAnswer { throw URLError(.timedOut) }
        return answer()
    }
    func stopKnown() { state = "cancelled" }
    func release() { let pending = heldRead; heldRead = nil; pending?.resume(returning: answer()) }
    var isHolding: Bool { heldRead != nil }
}

final class ShannonActionThreadsTests: XCTestCase {
    @MainActor func testLateOwnerReadingCannotReturnAfterAudienceChanges() async throws {
        let client = ThreadClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(hold: true)
        let read = Task { await model.reload() }
        for _ in 0..<100 {
            if await client.isHolding { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        let held = await client.isHolding
        XCTAssertTrue(held)
        model.reset(othersPresent: true)
        await client.release(); await read.value
        XCTAssertTrue(model.threads.isEmpty)
        XCTAssertNil(model.reading)
        await model.reload()
        XCTAssertTrue(model.threads.isEmpty)
        XCTAssertFalse(String(describing: model.reading).contains("Private title"))
    }
    @MainActor func testLostStopAnswerIsReadBackWithoutPostingTwice() async {
        let client = ThreadClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(losesAnswer: true)
        await model.reload(); await model.control(id: "one")
        let sends = await client.sends
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(model.threads.first?.state, "stopping")
        XCTAssertEqual(model.notice, ShannonGeneratedStrings.threadsAccepted)
        XCTAssertFalse(model.controlPending)
    }
    @MainActor func testServerAudienceHidesDetailsAndCanReturnToOwnerWithoutAClientToggle() async {
        let client = ThreadClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(others: true); await model.reload()
        XCTAssertTrue(model.othersPresent); XCTAssertTrue(model.threads.isEmpty)
        XCTAssertEqual(model.capsuleText, ShannonGeneratedStrings.threadsGeneric)
        await model.control(id: "one")
        let sends = await client.sends; XCTAssertEqual(sends, 0)
        await client.configure(others: false); await model.reload()
        XCTAssertFalse(model.othersPresent); XCTAssertEqual(model.threads.count, 1)
    }
    @MainActor func testOldServerReportCannotBecomeFreshWhenItsAnswerArrives() async {
        let client = ThreadClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(age: 60); await model.reload()
        XCTAssertTrue(model.isStale(at: Date()))
        await model.control(id: "one")
        let sends = await client.sends; XCTAssertEqual(sends, 0)
        await client.configure(); await model.reload()
        XCTAssertFalse(model.isStale(at: Date()))
    }
    @MainActor func testKnownStoppedOwnTimeKeepsItsResumeEntryWithNoRunningWork() async {
        let client = ThreadClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.stopKnown(); await model.reload()
        XCTAssertEqual(model.reading?.count, 0)
        XCTAssertTrue(model.showsCapsule)
        XCTAssertEqual(model.capsuleText, ShannonGeneratedStrings.threadsCancelled)
        await model.control(id: "one", resume: true)
        XCTAssertEqual(model.threads.first?.state, "queued")
        let sends = await client.sends; XCTAssertEqual(sends, 1)
    }
    @MainActor func testOldServerHidesTheFeatureAndDisconnectDropsThePreviousReading() async {
        let client = ThreadClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await model.reload()
        XCTAssertTrue(model.showsCapsule)
        model.reset(othersPresent: false, disconnected: true)
        XCTAssertNil(model.reading); XCTAssertFalse(model.showsCapsule)
        await client.configure(absent: true); await model.reload()
        XCTAssertEqual(model.phase, .hidden)
        await model.control(id: "one")
        let sends = await client.sends
        XCTAssertEqual(sends, 0)
    }
}
