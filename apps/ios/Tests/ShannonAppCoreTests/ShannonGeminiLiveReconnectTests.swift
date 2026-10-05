import XCTest
@testable import ShannonAppCore

/// Audio failures in a burst and the reconnect of the same call, driven through `start` itself.
@MainActor
final class ShannonGeminiLiveReconnectTests: XCTestCase {
    private struct Refused: Error {}

    /// Holds the reconnect's session request open until the test lets it go.
    @MainActor private final class Gate {
        var continuation: CheckedContinuation<ShannonGeminiLiveSessionDTO, Error>?
        var requests = 0
    }

    private func model(gate: Gate, reports: @escaping @MainActor (Bool) -> Void) async -> ShannonGeminiLiveSessionModel {
        let model = ShannonGeminiLiveSessionModel()
        model.microphoneUsageIsDeclared = { true }
        model.microphonePermission = { .granted }
        model.requestMicrophonePermission = { true }
        model.callReported = reports
        // The first start is refused, which leaves the call's handlers in place for its reconnects.
        await model.start(
            participantMode: .owner,
            createSession: { _ in
                gate.requests += 1
                if gate.requests == 1 { throw Refused() }
                return try await withCheckedThrowingContinuation { gate.continuation = $0 }
            },
            performDelegation: { _, _, _ in throw Refused() },
            performStreamingDelegation: { _, _, _, _ in throw Refused() },
            streamSpeech: { _, _ in throw Refused() },
            commitTurn: { _, _ in },
            handleDelegationResponse: { _ in }
        )
        XCTAssertEqual(model.phase, .failed)
        return model
    }

    func testFailuresAreAbsorbedOnlyWhileTheReconnectIsQueued() async {
        let gate = Gate()
        var reports: [Bool] = []
        let model = await model(gate: gate) { reports.append($0) }
        // As if that call were live and reported.
        model.phase = .listening
        model.errorMessage = nil
        model.failureRecovery = nil
        model.callIsReported = true
        model.lastAudioReconnectAt = nil

        model.audioFailed()
        model.audioFailed()
        XCTAssertEqual(model.phase, .reconnecting)
        XCTAssertNil(model.errorMessage, "no failure is shown for the second failure of the burst")

        // The one queued reconnect runs through start(sameCall) and asks for a session.
        while gate.continuation == nil { await Task.yield() }
        XCTAssertEqual(gate.requests, 2, "one reconnect")
        XCTAssertNotEqual(model.phase, .failed)
        XCTAssertEqual(reports, [], "the same call: no end, no second start")
        XCTAssertFalse(model.sameCallReconnectQueued, "the old transport is stopped: nothing is absorbed any more")

        // A failure of the new transport is a second failure soon after: the call ends where he can see it.
        model.audioFailed()
        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(reports, [false], "its end is reported once")
        gate.continuation?.resume(throwing: Refused())
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(model.phase, .failed)
        model.stop()
        XCTAssertEqual(reports, [false])
    }

    func testAQueuedReconnectDoesNothingOnceTheOwnerEndedTheCall() async {
        let gate = Gate()
        var reports: [Bool] = []
        let model = await model(gate: gate) { reports.append($0) }
        model.phase = .listening
        model.callIsReported = true
        model.lastAudioReconnectAt = nil
        model.audioFailed()
        model.stop()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(gate.requests, 1, "no session was asked for after 終了")
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(reports, [false])
    }

    func testEndingTheCallWhileItsReconnectWaitsForASessionAlsoEndsThatSession() async {
        let gate = Gate()
        var reports: [Bool] = []
        var abandoned = 0
        let model = await model(gate: gate) { reports.append($0) }
        model.sessionAbandoned = { abandoned += 1 }
        model.phase = .listening
        model.callIsReported = true
        model.lastAudioReconnectAt = nil
        model.audioFailed()
        while gate.continuation == nil { await Task.yield() }
        // 終了 while the reconnect's session is being made: stop() reports the end.
        model.stop()
        XCTAssertEqual(reports, [false])
        // The session arrives after all: the server noted it, so it hears an end of its own (`abandoned`), or it would
        // count it as a new call for a while. The call's own end is not sent twice.
        gate.continuation?.resume(returning: ShannonGeminiLiveSessionDTO(
            token: "t", model: "m", voice: "v", threadId: "th", instructions: "", expiresAt: "",
            inputUsdPerMinute: 0, outputUsdPerMinute: 0))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(abandoned, 1)
        XCTAssertEqual(reports, [false])
    }

    func testATransportReportsItsAudioFailureOnce() {
        var events: [ShannonTranscriptionEvent] = []
        let transport = ShannonGeminiLiveTransport(
            session: ShannonGeminiLiveSessionDTO(
                token: "t", model: "m", voice: "v", threadId: "th", instructions: "", expiresAt: "",
                inputUsdPerMinute: 0, outputUsdPerMinute: 0),
            eventHandler: { events.append($0) },
            captureHandler: { _, _, _, _, _ in },
            inputStateHandler: { _ in }
        )
        transport.reportAudioFailure()
        transport.reportAudioFailure()
        XCTAssertEqual(events.count, 1)
        transport.stop()
    }
}
