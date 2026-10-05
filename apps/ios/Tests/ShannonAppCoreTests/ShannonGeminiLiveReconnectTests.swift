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

    actor Reporter: ShannonBodyCallReporting {
        var sent: [ShannonBodyCallEventDTO] = []
        func sendBodyCallEvent(scopeKey: String, event: ShannonBodyCallEventDTO) async throws { sent.append(event) }
    }

    func testEndingTheCallWhileItsReconnectWaitsForASessionAlsoEndsThatSession() async {
        let suite = "shannon.tests.reconnect.\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let presence = ShannonVoiceCallPresence()
        presence.defaults = UserDefaults(suiteName: suite)!
        presence.holdBackgroundTime = { _ in {} }
        presence.retryDelay = { _ in }
        let reporter = Reporter()
        presence.configure(scopeKey: "owner", reporter: reporter, mayReport: { true })

        let gate = Gate()
        var reports: [Bool] = []
        let model = await model(gate: gate) { active in
            reports.append(active)
            if active { presence.began(audience: .owner) } else { presence.ended() }
        }
        model.sessionAbandoned = { presence.abandoned(audience: .owner) }
        presence.began(audience: .owner)
        model.phase = .listening
        model.callIsReported = true
        model.lastAudioReconnectAt = nil
        model.audioFailed()
        while gate.continuation == nil { await Task.yield() }
        // 終了 while the reconnect's session is being made: stop() reports the call's end.
        model.stop()
        XCTAssertEqual(reports, [false])
        // The session arrives after all. The server noted it now, so it hears an end of its own (`abandoned`),
        // stamped after that moment; otherwise it would count the session as a new call for a while.
        let noted = Date()
        gate.continuation?.resume(returning: ShannonGeminiLiveSessionDTO(
            token: "t", model: "m", voice: "v", threadId: "th", instructions: "", expiresAt: "",
            inputUsdPerMinute: 0, outputUsdPerMinute: 0))
        for _ in 0..<50 { await Task.yield() }
        await presence.settle()
        XCTAssertEqual(reports, [false], "the call's own end is not sent twice")
        let sent = await reporter.sent
        XCTAssertEqual(sent.map(\.type), [.callStarted, .callEnded, .callEnded])
        XCTAssertNotEqual(sent[1].id, sent[2].id, "the abandoned end has an id of its own")
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let stamped = formatter.date(from: sent[2].occurredAt)
        XCTAssertNotNil(stamped)
        XCTAssertGreaterThanOrEqual(stamped ?? .distantPast, noted.addingTimeInterval(-0.001), "stamped after the session was noted")
    }

    /// A same-call reconnect keeps the owner's hidden turns (and finishes words not yet finished, his staying his),
    /// and the next reply still answers them.
    func testHiddenOwnerTurnsSurviveASameCallReconnectAndAreStillAnswered() async {
        let gate = Gate()
        let model = await model(gate: gate) { _ in }
        model.phase = .listening
        model.callIsReported = true
        model.lastAudioReconnectAt = nil
        model.appendUtterance(rawText: "明日の歯医者は何時？", text: "明日の歯医者は何時？", source: .typed)
        model.handle(.speechStarted(itemID: "owner-a"))
        model.switchParticipantMode(to: .guest, origin: .spoken)
        model.handle(.inputTranscript("それと保険証", itemID: "owner-a"))
        XCTAssertTrue(model.bufferIsOwners)
        model.audioFailed()
        while gate.continuation == nil { await Task.yield() }
        XCTAssertEqual(model.participantMode, .guest)
        XCTAssertEqual(model.pendingTurns.turns.map(\.rawText), ["明日の歯医者は何時？", "それと保険証"],
                       "kept, and the words being assembled were finished, not dropped")
        XCTAssertEqual(model.pendingTurns.displayText, "", "both still hidden")
        var answered: String?
        model.performStreamingDelegation = { text, _, _, _ in
            answered = text
            throw Refused()
        }
        model.beginResponse()
        for _ in 0..<200 where answered == nil { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(answered, "明日の歯医者は何時？\nそれと保険証", "still answered in the call")
        gate.continuation?.resume(throwing: Refused())
        for _ in 0..<20 { await Task.yield() }
        model.stop()
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
