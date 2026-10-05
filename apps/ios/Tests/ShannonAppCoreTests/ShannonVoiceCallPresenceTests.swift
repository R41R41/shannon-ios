import XCTest
@testable import ShannonAppCore

/// The iPhone tells the server when a voice call runs on it, so that her desktop body keeps quiet (docs/body-contract.md).
@MainActor
final class ShannonVoiceCallPresenceTests: XCTestCase {
    actor Reporter: ShannonBodyCallReporting {
        var sent: [ShannonBodyCallEventDTO] = []
        var failures: [Error] = []
        func failNext(_ error: Error) { failures.append(error) }
        func sendBodyCallEvent(scopeKey: String, event: ShannonBodyCallEventDTO) async throws {
            if !failures.isEmpty { throw failures.removeFirst() }
            sent.append(event)
        }
    }

    private var suites: [String] = []

    override func tearDown() {
        for suite in suites { UserDefaults().removePersistentDomain(forName: suite) }
        suites = []
        super.tearDown()
    }

    private func presence(_ reporter: Reporter?, mayReport: Bool = true, defaults: UserDefaults? = nil,
                          runStartedAt: Date = Date(timeIntervalSince1970: 1_791_199_000)) -> ShannonVoiceCallPresence {
        let presence = ShannonVoiceCallPresence(runStartedAt: runStartedAt)
        if let defaults {
            presence.defaults = defaults
        } else {
            let suite = "shannon.tests.call-presence.\(UUID().uuidString)"
            suites.append(suite)
            presence.defaults = UserDefaults(suiteName: suite)!
        }
        presence.holdBackgroundTime = { _ in {} }
        presence.configure(scopeKey: "owner", reporter: reporter, mayReport: { mayReport })
        presence.now = { Date(timeIntervalSince1970: 1_791_200_000) }
        presence.retryDelay = { _ in }
        return presence
    }

    func testReportsTheStartAndTheEndOfOneCallOnceEachWithOneId() async {
        let reporter = Reporter()
        let presence = presence(reporter)
        presence.began(audience: .owner)
        presence.began(audience: .owner)
        presence.ended()
        presence.ended()
        await presence.settle()
        let sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted, .callEnded])
        XCTAssertEqual(sent.map(\.audience), [.owner, .owner])
        let callID = sent[0].id.replacingOccurrences(of: "-started", with: "")
        XCTAssertEqual(sent[1].id, "\(callID)-ended")
        XCTAssertTrue(sent.allSatisfy { $0.id.count <= 80 && $0.id.range(of: "^[a-z0-9][A-Za-z0-9_.:-]*$", options: .regularExpression) != nil })
        XCTAssertEqual(sent[0].occurredAt, "2026-10-05T11:33:20.000Z")
    }

    func testAGuestCallIsReportedForOthersAndAnEndWithoutAStartSendsNothing() async {
        let reporter = Reporter()
        let presence = presence(reporter)
        presence.ended()
        presence.began(audience: .others)
        presence.ended()
        await presence.settle()
        let sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted, .callEnded])
        XCTAssertEqual(sent.map(\.audience), [.others, .others])
    }

    func testSendsNothingInADesignPreviewOrWithoutAClientThatReportsCalls() async {
        let reporter = Reporter()
        let preview = presence(reporter, mayReport: false)
        preview.began(audience: .owner)
        preview.ended()
        await preview.settle()
        let sent = await reporter.sent
        XCTAssertTrue(sent.isEmpty)
        let none = presence(nil)
        none.began(audience: .owner)
        none.ended()
        await none.settle()
    }

    func testRetriesANetworkFailureAndGivesUpOnARefusal() async {
        let reporter = Reporter()
        await reporter.failNext(URLError(.notConnectedToInternet))
        let presence = presence(reporter)
        presence.began(audience: .owner)
        await presence.settle()
        var sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted])
        await reporter.failNext(ShannonBodyRefusal(status: 403, code: "BODY_INGEST_DISABLED"))
        presence.ended()
        await presence.settle()
        sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted])
    }

    func testKeepsAnEndThatDidNotGetThroughAndSendsItAgainLaterWithTheSameContent() async {
        let reporter = Reporter()
        let presence = presence(reporter)
        presence.began(audience: .owner)
        await presence.settle()
        XCTAssertEqual(presence.pending().map(\.occurredAt), [nil], "the end is owed from the start of the call")
        for _ in 0..<3 { await reporter.failNext(URLError(.notConnectedToInternet)) }
        presence.ended()
        await presence.settle()
        var sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted])
        let kept = presence.pending()
        XCTAssertEqual(kept.count, 1)
        presence.resendUndelivered(scopeKey: "owner", reporter: reporter)
        await presence.settle()
        sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted, .callEnded])
        XCTAssertEqual(sent[1].occurredAt, kept[0].occurredAt)
        XCTAssertTrue(presence.pending().isEmpty)
    }

    func testSendsTheEndOfACallTheAppWasClosedInAtTheNextLaunchButNeverTheRunningCallsEnd() async {
        let suite = "shannon.tests.call-presence.\(UUID().uuidString)"
        suites.append(suite)
        let defaults = UserDefaults(suiteName: suite)!
        let reporter = Reporter()
        let before = presence(reporter, defaults: defaults)
        before.began(audience: .owner)
        await before.settle()
        // The running call's end is not sent on a return to the foreground.
        before.resendUndelivered(scopeKey: "owner", reporter: reporter)
        await before.settle()
        var sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted])
        // The app was killed during the call; when the view of the next run becomes active, its end is sent, stamped
        // when that run began, never "now".
        let after = presence(nil, defaults: defaults)
        after.resendUndelivered(scopeKey: "owner", reporter: reporter)
        await after.settle()
        sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted, .callEnded])
        XCTAssertEqual(sent[1].id, sent[0].id.replacingOccurrences(of: "-started", with: "-ended"))
        XCTAssertEqual(sent[1].occurredAt, "2026-10-05T11:16:40.000Z")
        XCTAssertTrue(after.pending().isEmpty)
    }

    /// Her call is answered from the lock screen in a new run, while a killed run still owes an end without a time; the
    /// conversation view becomes active only later. The old end must come out before the live call's start, so that the
    /// server, which matches by device, keeps the live call.
    func testAStaleEndOfAKilledRunNeverEndsACallAnsweredFromTheLockScreen() async {
        let suite = "shannon.tests.call-presence.\(UUID().uuidString)"
        suites.append(suite)
        let defaults = UserDefaults(suiteName: suite)!
        let reporter = Reporter()
        let killed = presence(reporter, defaults: defaults)
        killed.began(audience: .owner)
        await killed.settle()
        // The next run: `shared` is first used by the answered call itself, a minute after the run began.
        let run = presence(reporter, defaults: defaults, runStartedAt: Date(timeIntervalSince1970: 1_791_200_000))
        run.now = { Date(timeIntervalSince1970: 1_791_200_060) }
        run.began(audience: .owner)
        // The view becomes active later, with the call still running.
        run.now = { Date(timeIntervalSince1970: 1_791_200_300) }
        run.resendUndelivered(scopeKey: "owner", reporter: reporter)
        await run.settle()
        let sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted, .callEnded, .callStarted])
        let liveStart = sent[2]
        let staleEnd = sent[1]
        XCTAssertEqual(staleEnd.id, sent[0].id.replacingOccurrences(of: "-started", with: "-ended"))
        XCTAssertLessThan(staleEnd.occurredAt, liveStart.occurredAt)
        XCTAssertEqual(staleEnd.occurredAt, "2026-10-05T11:33:20.000Z")
        XCTAssertEqual(liveStart.occurredAt, "2026-10-05T11:34:20.000Z")
        // The live call's own end is still owed, and was not sent.
        XCTAssertEqual(run.pending().map(\.occurredAt), [nil])
    }

    func testResendUsesTheClientItIsGiven() async {
        let old = Reporter()
        let current = Reporter()
        for _ in 0..<3 { await old.failNext(URLError(.notConnectedToInternet)) }
        let presence = presence(old)
        presence.abandoned(audience: .owner)
        await presence.settle()
        XCTAssertEqual(presence.pending().count, 1)
        // A new pairing: the conversation hands its new client over, and the old one is not used again.
        presence.resendUndelivered(scopeKey: "owner", reporter: current)
        await presence.settle()
        let byCurrent = await current.sent
        let byOld = await old.sent
        XCTAssertEqual(byCurrent.map(\.type), [.callEnded])
        XCTAssertTrue(byOld.isEmpty)
        XCTAssertTrue(presence.pending().isEmpty)
    }

    func testASessionCancelledBeforeTheCallBeganIsEnded() async {
        let reporter = Reporter()
        let presence = presence(reporter)
        presence.abandoned(audience: .owner)
        await presence.settle()
        let sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callEnded])
        XCTAssertTrue(presence.pending().isEmpty)
    }

    func testTheEventCarriesOnlyTheFieldsOfAPlainEvent() throws {
        let event = ShannonBodyCallEventDTO(id: "call-1-started", type: .callStarted, audience: .owner, occurredAt: "2026-10-05T11:33:20.000Z")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["id", "type", "audience", "occurredAt"])
        XCTAssertEqual(object["type"] as? String, "callStarted")
    }
}
