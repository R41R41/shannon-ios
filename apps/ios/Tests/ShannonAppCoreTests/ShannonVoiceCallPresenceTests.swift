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

    private func presence(_ reporter: Reporter?, mayReport: Bool = true) -> ShannonVoiceCallPresence {
        let presence = ShannonVoiceCallPresence()
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

    func testTheEventCarriesOnlyTheFieldsOfAPlainEvent() throws {
        let event = ShannonBodyCallEventDTO(id: "call-1-started", type: .callStarted, audience: .owner, occurredAt: "2026-10-05T11:33:20.000Z")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["id", "type", "audience", "occurredAt"])
        XCTAssertEqual(object["type"] as? String, "callStarted")
    }
}
