import XCTest
@testable import ShannonAppCore

/// A call from Shannon, without the phone: the machine alone, and the coordinator with a fake call screen,
/// a fake server, a fake voice and a fake conversation. CallKit and PushKit themselves need a device.
@MainActor
final class ShannonIncomingCallTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_790_000_000)
    private let callUUID = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    private let fresh = UUID(uuidString: "00000000-0000-4000-8000-0000000000FF")!
    private let line = "ライ氏、さっき読んだ話をしてもいいですか。"

    private func payload(expiresIn seconds: TimeInterval = 30, id: UUID? = nil) -> ShannonIncomingCallPayload {
        let id = id ?? callUUID
        return ShannonIncomingCallPayload(
            callID: id.uuidString.lowercased(), id: id, reachOutID: "r1", threadID: "t1", expiresAt: start.addingTimeInterval(seconds)
        )
    }

    private var callID: String { callUUID.uuidString.lowercased() }

    // MARK: The push payload

    func testThePayloadIsIdentifiersAndATimeAndAnythingElseIsNotACall() {
        let parsed = ShannonIncomingCallPayload(dictionary: [
            "aps": [String: Any](), "shannonCall": 1, "callId": "00000000-0000-4000-8000-000000000001",
            "reachOutId": "r1", "threadId": "t1", "expiresAt": "2026-10-03T03:00:30.000Z",
        ])
        XCTAssertEqual(parsed?.id, callUUID)
        XCTAssertEqual(parsed?.callID, "00000000-0000-4000-8000-000000000001")
        XCTAssertEqual(parsed?.reachOutID, "r1")
        XCTAssertEqual(parsed?.threadID, "t1")
        XCTAssertEqual(parsed?.expiresAt, ISO8601DateFormatter().date(from: "2026-10-03T03:00:30Z"))
        XCTAssertNil(ShannonIncomingCallPayload(dictionary: [:]))
        XCTAssertNil(ShannonIncomingCallPayload(dictionary: ["callId": "not-a-uuid", "reachOutId": "r1", "threadId": "t1", "expiresAt": "2026-10-03T03:00:30Z"]))
        XCTAssertNil(ShannonIncomingCallPayload(dictionary: ["callId": callUUID.uuidString, "reachOutId": "r1", "threadId": "t1", "expiresAt": "soon"]))
        XCTAssertNil(ShannonIncomingCallPayload(dictionary: ["callId": callUUID.uuidString, "reachOutId": "", "threadId": "t1", "expiresAt": "2026-10-03T03:00:30Z"]))
    }

    // MARK: The machine

    func testACallGoesFromRingingToHerLineToAConversationAndEnds() {
        var machine = ShannonIncomingCallMachine()
        XCTAssertEqual(machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true),
                       [.showIncoming(callUUID), .scheduleRingTimeout(callUUID, at: start.addingTimeInterval(30))])
        XCTAssertEqual(machine.call?.phase, .ringing)
        XCTAssertTrue(machine.isActive)
        XCTAssertEqual(machine.answer(callUUID),
                       [.cancelTimeouts, .prepareAudio, .claim(reachOutID: "r1", callID: callID), .scheduleConnectTimeout(callUUID)])
        XCTAssertEqual(machine.call?.phase, .connecting)
        // Her words arrive before the system activated the audio: nothing is said yet.
        XCTAssertEqual(machine.claimed(callID: callID, line: line), [])
        XCTAssertEqual(machine.audioActivated(), [.cancelTimeouts, .speak(line)])
        XCTAssertEqual(machine.call?.phase, .speaking)
        XCTAssertEqual(machine.lineFinished(canListen: true), [.startConversation(threadID: "t1")])
        XCTAssertEqual(machine.call?.phase, .conversation)
        XCTAssertEqual(machine.conversationEnded(), [.endSystemCall(callUUID, .remoteEnded)])
        XCTAssertNil(machine.call)
        XCTAssertFalse(machine.isActive)
    }

    func testHerLineWaitsForTheAudioWhicheverComesFirst() {
        var machine = ShannonIncomingCallMachine()
        _ = machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = machine.answer(callUUID)
        XCTAssertEqual(machine.audioActivated(), [])
        XCTAssertEqual(machine.claimed(callID: callID, line: line), [.cancelTimeouts, .speak(line)])
        // The same words again (a repeated answer of the server) are not said twice.
        XCTAssertEqual(machine.claimed(callID: callID, line: line), [])
    }

    func testDecliningIsReportedAsDeclinedAndNothingIsSaid() {
        var machine = ShannonIncomingCallMachine()
        _ = machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        XCTAssertEqual(machine.hangUp(callUUID), [.cancelTimeouts, .report(callID: callID, .declined)])
        XCTAssertNil(machine.call)
        // What arrives afterwards finds no call.
        XCTAssertEqual(machine.answer(callUUID), [])
        XCTAssertEqual(machine.claimed(callID: callID, line: line), [])
        XCTAssertEqual(machine.ringTimedOut(callUUID), [])
    }

    func testARingNobodyAnsweredEndsAsAMissedCall() {
        var machine = ShannonIncomingCallMachine()
        _ = machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        XCTAssertEqual(machine.ringTimedOut(callUUID), [.endSystemCall(callUUID, .unanswered), .report(callID: callID, .unanswered)])
        XCTAssertNil(machine.call)
        // Once answered, the ring's timer means nothing.
        var answered = ShannonIncomingCallMachine()
        _ = answered.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = answered.answer(callUUID)
        XCTAssertEqual(answered.ringTimedOut(callUUID), [])
    }

    func testEveryPushIsShownToTheSystemFirstWhateverItHolds() {
        // Not a call payload.
        var machine = ShannonIncomingCallMachine()
        XCTAssertEqual(machine.push(nil, fresh: fresh, now: start, busy: false, enabled: true),
                       [.showIncoming(fresh), .endSystemCall(fresh, .failed)])
        XCTAssertNil(machine.call)
        // Already expired when it arrived: a missed call.
        XCTAssertEqual(machine.push(payload(expiresIn: 0), fresh: fresh, now: start, busy: false, enabled: true),
                       [.showIncoming(callUUID), .endSystemCall(callUUID, .unanswered), .report(callID: callID, .unanswered)])
        XCTAssertNil(machine.call)
        // The same call again: shown under another identifier and ended, without a second report.
        XCTAssertEqual(machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true),
                       [.showIncoming(fresh), .endSystemCall(fresh, .answeredElsewhere)])
        // The owner switched calls off.
        var off = ShannonIncomingCallMachine()
        XCTAssertEqual(off.push(payload(), fresh: fresh, now: start, busy: false, enabled: false),
                       [.showIncoming(callUUID), .endSystemCall(callUUID, .failed), .report(callID: callID, .failed)])
        XCTAssertNil(off.call)
        for effects in [
            machine.push(nil, fresh: fresh, now: start, busy: true, enabled: false),
            off.push(payload(id: UUID()), fresh: fresh, now: start, busy: true, enabled: true),
        ] {
            guard case .showIncoming = effects.first else { return XCTFail("a push was not shown to the system first") }
        }
    }

    func testAPushDuringAConversationOrAnotherCallIsShownAndEndedAtOnce() {
        var busy = ShannonIncomingCallMachine()
        XCTAssertEqual(busy.push(payload(), fresh: fresh, now: start, busy: true, enabled: true),
                       [.showIncoming(callUUID), .endSystemCall(callUUID, .answeredElsewhere), .report(callID: callID, .failed)])
        XCTAssertNil(busy.call)

        var machine = ShannonIncomingCallMachine()
        _ = machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        let other = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
        XCTAssertEqual(machine.push(payload(id: other), fresh: fresh, now: start, busy: false, enabled: true),
                       [.showIncoming(other), .endSystemCall(other, .answeredElsewhere), .report(callID: other.uuidString.lowercased(), .failed)])
        // The first call still rings.
        XCTAssertEqual(machine.call?.id, callUUID)
        XCTAssertEqual(machine.call?.phase, .ringing)
        // A duplicate of the ringing call does not disturb it either.
        XCTAssertEqual(machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true),
                       [.showIncoming(fresh), .endSystemCall(fresh, .answeredElsewhere)])
        XCTAssertEqual(machine.call?.phase, .ringing)
    }

    func testHangingUpStopsWhateverIsRunning() {
        var speaking = ShannonIncomingCallMachine()
        _ = speaking.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = speaking.answer(callUUID)
        _ = speaking.audioActivated()
        _ = speaking.claimed(callID: callID, line: line)
        XCTAssertEqual(speaking.hangUp(callUUID), [.stopSpeaking])
        XCTAssertEqual(speaking.lineFinished(canListen: true), [])

        var talking = speaking
        _ = talking.push(payload(id: UUID(uuidString: "00000000-0000-4000-8000-000000000003")!), fresh: fresh, now: start, busy: false, enabled: true)
        let id = talking.call!.id
        _ = talking.answer(id)
        _ = talking.audioActivated()
        _ = talking.claimed(callID: id.uuidString.lowercased(), line: line)
        _ = talking.lineFinished(canListen: true)
        XCTAssertEqual(talking.hangUp(id), [.stopConversation])
        XCTAssertNil(talking.call)
        // The conversation ending afterwards reports nothing to a system that already knows.
        XCTAssertEqual(talking.conversationEnded(), [])

        // Hung up between answering and her first word: for her, a call he chose not to take.
        var early = ShannonIncomingCallMachine()
        _ = early.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = early.answer(callUUID)
        XCTAssertEqual(early.hangUp(callUUID), [.cancelTimeouts, .report(callID: callID, .declined)])
    }

    func testACallThatCannotGoOnEndsWhereHeCanSeeIt() {
        var noWords = ShannonIncomingCallMachine()
        _ = noWords.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = noWords.answer(callUUID)
        XCTAssertEqual(noWords.claimFailed(callID: callID),
                       [.cancelTimeouts, .endSystemCall(callUUID, .failed), .report(callID: callID, .failed)])
        XCTAssertNil(noWords.call)

        var noAudio = ShannonIncomingCallMachine()
        _ = noAudio.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = noAudio.answer(callUUID)
        _ = noAudio.claimed(callID: callID, line: line)
        XCTAssertEqual(noAudio.connectTimedOut(callUUID), [.endSystemCall(callUUID, .failed), .report(callID: callID, .failed)])

        // Without the microphone her line is heard and the call ends: there is nothing to listen with.
        var noMicrophone = ShannonIncomingCallMachine()
        _ = noMicrophone.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = noMicrophone.answer(callUUID)
        _ = noMicrophone.audioActivated()
        _ = noMicrophone.claimed(callID: callID, line: line)
        XCTAssertEqual(noMicrophone.lineFinished(canListen: false), [.endSystemCall(callUUID, .remoteEnded)])
        XCTAssertNil(noMicrophone.call)

        // A Focus kept the phone from ringing: nobody answered. Any other refusal: the call failed.
        var silenced = ShannonIncomingCallMachine()
        _ = silenced.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        XCTAssertEqual(silenced.showFailed(callUUID, silenced: true), [.cancelTimeouts, .report(callID: callID, .unanswered)])
        XCTAssertNil(silenced.call)
        var refused = ShannonIncomingCallMachine()
        _ = refused.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        XCTAssertEqual(refused.showFailed(callUUID, silenced: false), [.cancelTimeouts, .report(callID: callID, .failed)])
    }

    func testTheSystemsMuteIsTheConversationsMute() {
        var machine = ShannonIncomingCallMachine()
        _ = machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        _ = machine.answer(callUUID)
        _ = machine.audioActivated()
        _ = machine.claimed(callID: callID, line: line)
        // Muted while she speaks: kept for the conversation.
        XCTAssertEqual(machine.muted(callUUID, true), [])
        XCTAssertEqual(machine.lineFinished(canListen: true), [.startConversation(threadID: "t1"), .setMuted(true)])
        XCTAssertEqual(machine.muted(callUUID, false), [.setMuted(false)])
        XCTAssertEqual(machine.muted(UUID(), true), [])
    }

    func testAResetOfTheSystemStopsTheCall() {
        var machine = ShannonIncomingCallMachine()
        _ = machine.push(payload(), fresh: fresh, now: start, busy: false, enabled: true)
        XCTAssertEqual(machine.reset(), [.cancelTimeouts, .report(callID: callID, .failed)])
        XCTAssertNil(machine.call)
        XCTAssertEqual(machine.reset(), [])
    }

    // MARK: The coordinator

    private struct World {
        let coordinator: ShannonIncomingCallCoordinator
        let system: FakeSystem
        let server: FakeCallServer
        let speaker: FakeCallSpeaker
        let conversation: FakeConversation
        let clock: Clock
    }

    @MainActor
    private final class Clock {
        var now: Date
        var enabled = true
        /// Timers wait here until a test lets one run.
        var sleepers: [(seconds: TimeInterval, wake: CheckedContinuation<Bool, Never>)] = []
        init(_ now: Date) { self.now = now }

        func wake(where matches: (TimeInterval) -> Bool, completed: Bool = true) {
            let waiting = sleepers
            sleepers = waiting.filter { !matches($0.seconds) }
            for sleeper in waiting where matches(sleeper.seconds) { sleeper.wake.resume(returning: completed) }
        }
    }

    private func world() -> World {
        let system = FakeSystem()
        let server = FakeCallServer(line: line)
        let speaker = FakeCallSpeaker()
        let conversation = FakeConversation()
        let clock = Clock(start)
        let coordinator = ShannonIncomingCallCoordinator(server: server, system: system, speaker: speaker, conversation: conversation)
        coordinator.now = { clock.now }
        coordinator.isEnabled = { clock.enabled }
        coordinator.sleep = { seconds in
            await withCheckedContinuation { continuation in clock.sleepers.append((seconds, continuation)) }
        }
        return World(coordinator: coordinator, system: system, server: server, speaker: speaker, conversation: conversation, clock: clock)
    }

    private func finish(_ w: World) async {
        // Timers that never fire are let go, so no task is left waiting.
        for _ in 0..<5 {
            await Task.yield()
            w.clock.wake(where: { _ in true }, completed: false)
        }
        await w.coordinator.settle()
    }

    func testAnAnsweredCallSaysHerLineThenRunsTheConversationOnHerTalkAndEndsWithIt() async {
        let w = world()
        w.coordinator.receivedPush(payload())
        XCTAssertEqual(w.system.events, [.shown(callUUID)])
        XCTAssertTrue(w.coordinator.isActive)
        XCTAssertEqual(w.coordinator.phase, .ringing)

        w.coordinator.answered(callUUID)
        XCTAssertEqual(w.conversation.prepared, 1)
        w.coordinator.audioActivated()
        await w.coordinator.settle()
        XCTAssertEqual(w.server.answers, ["r1/\(callID)"])
        XCTAssertEqual(w.speaker.spoken, [line])
        XCTAssertEqual(w.conversation.started, ["t1"])
        XCTAssertEqual(w.coordinator.phase, .conversation)
        // The app does not report "answered": taking her words told the server.
        XCTAssertEqual(w.server.reports, [])

        // The conversation ends (終了 in the app, or silence in the background): the system's call ends with it.
        w.conversation.end()
        XCTAssertEqual(w.system.events, [.shown(callUUID), .ended(callUUID, .remoteEnded)])
        // The audio session is the call's until the system took it back: standby does not start on it before.
        XCTAssertTrue(w.coordinator.isActive)
        w.coordinator.audioDeactivated()
        XCTAssertFalse(w.coordinator.isActive)
        await finish(w)
    }

    func testTheAudioIsLetGoEvenIfTheSystemNeverSaysItTookItBack() async {
        let w = world()
        w.coordinator.receivedPush(payload())
        w.coordinator.answered(callUUID)
        w.coordinator.audioActivated()
        await w.coordinator.settle()
        w.coordinator.hungUp(callUUID)
        XCTAssertTrue(w.coordinator.isActive)
        while !w.clock.sleepers.contains(where: { $0.seconds == 5 }) { await Task.yield() }
        w.clock.wake(where: { $0 == 5 })
        while w.coordinator.isActive { await Task.yield() }
        await finish(w)
    }

    func testAnAnswerToACallThatNoLongerRingsFails() async {
        let w = world()
        XCTAssertFalse(w.coordinator.answered(callUUID))
        w.coordinator.receivedPush(payload())
        XCTAssertTrue(w.coordinator.answered(callUUID))
        XCTAssertFalse(w.coordinator.answered(callUUID))
        w.coordinator.hungUp(callUUID)
        await finish(w)
    }

    func testAConversationTheOwnerStartsInTheAppEndsACallThatStillRings() async {
        let ringing = world()
        ringing.coordinator.receivedPush(payload())
        ringing.coordinator.appConversationWillBegin()
        XCTAssertEqual(ringing.system.events, [.shown(callUUID), .ended(callUUID, .answeredElsewhere)])
        XCTAssertFalse(ringing.coordinator.isActive)
        await finish(ringing)
        XCTAssertEqual(ringing.server.reports, ["\(callID):failed"])

        // It began just before he answered: the answer fails and the call ends the same way.
        let answered = world()
        answered.coordinator.receivedPush(payload())
        answered.conversation.isBusy = true
        XCTAssertFalse(answered.coordinator.answered(callUUID))
        XCTAssertEqual(answered.system.events, [.shown(callUUID), .ended(callUUID, .answeredElsewhere)])
        await finish(answered)
        XCTAssertEqual(answered.server.answers, [])

        // The call's own conversation is not what ends it.
        let talking = world()
        talking.coordinator.receivedPush(payload())
        talking.coordinator.answered(callUUID)
        talking.coordinator.audioActivated()
        await talking.coordinator.settle()
        talking.coordinator.appConversationWillBegin()
        XCTAssertEqual(talking.coordinator.phase, .conversation)
        talking.coordinator.hungUp(callUUID)
        talking.coordinator.audioDeactivated()
        await finish(talking)
    }

    func testHangingUpFromTheSystemEndsTheConversationAndMuteReachesIt() async {
        let w = world()
        w.coordinator.receivedPush(payload())
        w.coordinator.answered(callUUID)
        w.coordinator.audioActivated()
        await w.coordinator.settle()
        w.coordinator.muted(callUUID, true)
        XCTAssertEqual(w.conversation.mutes, [true])
        w.coordinator.hungUp(callUUID)
        XCTAssertEqual(w.conversation.stops, 1)
        // The system ended it itself: it is not told again.
        XCTAssertEqual(w.system.events, [.shown(callUUID)])
        w.coordinator.audioDeactivated()
        XCTAssertFalse(w.coordinator.isActive)
        await finish(w)
    }

    func testDecliningAndNotAnsweringAreReportedAndNothingIsTakenOrSaid() async {
        let declined = world()
        declined.coordinator.receivedPush(payload())
        declined.coordinator.hungUp(callUUID)
        await finish(declined)
        XCTAssertEqual(declined.server.reports, ["\(callID):declined"])
        XCTAssertEqual(declined.server.answers, [])
        XCTAssertEqual(declined.speaker.spoken, [])
        XCTAssertFalse(declined.coordinator.isActive)

        let missed = world()
        missed.coordinator.receivedPush(payload())
        while missed.clock.sleepers.isEmpty { await Task.yield() }
        // The ring's timer waits exactly until the push's own expiry.
        XCTAssertEqual(missed.clock.sleepers.map(\.seconds), [30])
        missed.clock.now = start.addingTimeInterval(30)
        missed.clock.wake(where: { $0 == 30 })
        await Task.yield()
        await finish(missed)
        XCTAssertEqual(missed.system.events, [.shown(callUUID), .ended(callUUID, .unanswered)])
        XCTAssertEqual(missed.server.reports, ["\(callID):unanswered"])
        XCTAssertEqual(missed.speaker.spoken, [])
    }

    func testAPushDuringAConversationInTheAppIsShownEndedAndNeverRings() async {
        let w = world()
        w.conversation.isBusy = true
        w.coordinator.receivedPush(payload())
        XCTAssertEqual(w.system.events, [.shown(callUUID), .ended(callUUID, .answeredElsewhere)])
        XCTAssertFalse(w.coordinator.isActive)
        await finish(w)
        XCTAssertEqual(w.server.reports, ["\(callID):failed"])
        XCTAssertEqual(w.server.answers, [])
        XCTAssertEqual(w.conversation.started, [])
    }

    func testAMalformedOrDuplicatePushStillReportsACallToTheSystem() async {
        let w = world()
        w.coordinator.receivedPush(nil)
        XCTAssertEqual(w.system.events.count, 2)
        guard case let .shown(first) = w.system.events[0], case .ended(first, .failed) = w.system.events[1] else {
            return XCTFail("a push that is not a call was not shown and ended")
        }
        w.coordinator.receivedPush(payload())
        w.coordinator.receivedPush(payload())
        XCTAssertEqual(w.system.events.count, 5)
        XCTAssertEqual(w.system.events[2], .shown(callUUID))
        guard case let .shown(again) = w.system.events[3], case .ended(again, .answeredElsewhere) = w.system.events[4] else {
            return XCTFail("a duplicate push was not shown and ended")
        }
        XCTAssertNotEqual(again, callUUID)
        XCTAssertEqual(w.coordinator.phase, .ringing)
        w.coordinator.hungUp(callUUID)
        await finish(w)
    }

    func testWithTheSwitchOffAPushIsShownEndedAndReportedAsFailed() async {
        let w = world()
        w.clock.enabled = false
        w.coordinator.receivedPush(payload())
        XCTAssertEqual(w.system.events, [.shown(callUUID), .ended(callUUID, .failed)])
        await finish(w)
        XCTAssertEqual(w.server.reports, ["\(callID):failed"])
    }

    func testWhenHerWordsCannotBeTakenTheCallEndsAndSaysSo() async {
        let w = world()
        w.server.answerFails = true
        w.coordinator.receivedPush(payload())
        w.coordinator.answered(callUUID)
        w.coordinator.audioActivated()
        await Task.yield()
        await finish(w)
        XCTAssertEqual(w.system.events, [.shown(callUUID), .ended(callUUID, .failed)])
        XCTAssertEqual(w.speaker.spoken, [])
        XCTAssertEqual(w.conversation.started, [])
        XCTAssertEqual(w.server.reports, ["\(callID):failed"])
        w.coordinator.audioDeactivated()
        XCTAssertFalse(w.coordinator.isActive)
    }

    func testAConversationThatCannotStartEndsTheCall() async {
        let w = world()
        w.conversation.starts = false
        w.coordinator.receivedPush(payload())
        w.coordinator.answered(callUUID)
        w.coordinator.audioActivated()
        await w.coordinator.settle()
        XCTAssertEqual(w.speaker.spoken, [line])
        XCTAssertEqual(w.system.events, [.shown(callUUID), .ended(callUUID, .remoteEnded)])
        w.coordinator.audioDeactivated()
        XCTAssertFalse(w.coordinator.isActive)
        await finish(w)
    }

    func testHangingUpWhileSheSpeaksStopsHerVoiceAndStartsNoConversation() async {
        let w = world()
        w.speaker.holds = true
        w.coordinator.receivedPush(payload())
        w.coordinator.answered(callUUID)
        w.coordinator.audioActivated()
        while w.speaker.spoken.isEmpty { await Task.yield() }
        XCTAssertEqual(w.coordinator.phase, .speaking)
        w.coordinator.hungUp(callUUID)
        XCTAssertEqual(w.speaker.stops, 1)
        await finish(w)
        XCTAssertEqual(w.conversation.started, [])
        w.coordinator.audioDeactivated()
        XCTAssertFalse(w.coordinator.isActive)
    }

    func testAReportThatDidNotGetThroughIsTriedAgain() async {
        let w = world()
        w.server.reportFailures = 1
        w.coordinator.receivedPush(payload())
        w.coordinator.hungUp(callUUID)
        while !w.clock.sleepers.contains(where: { $0.seconds == 2 }) { await Task.yield() }
        w.clock.wake(where: { $0 == 2 })
        await w.coordinator.settle()
        XCTAssertEqual(w.server.reports, ["\(callID):declined", "\(callID):declined"])
    }

    // MARK: The owner's switch

    func testTheSwitchIsOffUntilTheOwnerTurnsItOnAndThenRegistersThisPhone() async {
        let suite = "incoming-call-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let server = FakeCallServer(line: line)
        let settings = ShannonIncomingCallSettings(server: server, environment: .production, bundleID: "com.r41r41.shannon", defaults: defaults)
        var protection: [Bool] = []
        settings.setCredentialReadableWhileLocked = { protection.append($0) }
        XCTAssertFalse(settings.isEnabled)
        XCTAssertEqual(settings.status, .off)
        // The phone's call address alone tells the server nothing.
        settings.received(token: "ab12")
        await settings.synchronize()
        XCTAssertEqual(server.registrations, [])

        settings.setEnabled(true)
        await settings.synchronize()
        // Telling the server again is harmless: the same token, the same switch.
        XCTAssertFalse(server.registrations.isEmpty)
        XCTAssertEqual(Set(server.registrations), ["ab12:production:com.r41r41.shannon:true"])
        XCTAssertEqual(settings.status, .ready)
        XCTAssertEqual(protection, [true])

        // A new launch remembers the switch.
        let relaunched = ShannonIncomingCallSettings(server: server, environment: .production, bundleID: "com.r41r41.shannon", defaults: defaults)
        XCTAssertTrue(relaunched.isEnabled)
        XCTAssertEqual(relaunched.status, .preparing)

        // Switched off, the server is told, and the credential goes back to its stricter protection.
        settings.setEnabled(false)
        await settings.synchronize()
        XCTAssertEqual(server.registrations.last, "ab12:production:com.r41r41.shannon:false")
        XCTAssertEqual(settings.status, .off)
        XCTAssertEqual(protection, [true, false])
        // Once the server knows it is off, nothing more is sent about this phone.
        await settings.synchronize()
        let count = server.registrations.count
        await settings.synchronize()
        XCTAssertEqual(server.registrations.count, count)
    }

    func testTheStatusSaysTruthfullyWhyNoCallCanCome() async {
        let suite = "incoming-call-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let server = FakeCallServer(line: line)
        let settings = ShannonIncomingCallSettings(server: server, environment: .sandbox, bundleID: "com.r41r41.shannon", defaults: defaults)
        settings.setEnabled(true)
        await settings.synchronize()
        // The phone has not handed over its address yet.
        XCTAssertEqual(settings.status, .preparing)
        server.available = false
        settings.received(token: "ab12")
        await settings.synchronize()
        XCTAssertEqual(settings.status, .serverNotReady)
        XCTAssertEqual(ShannonIncomingCallCopy.statusText(settings.status), "サーバー側の準備がまだです")
        server.paired = false
        await settings.synchronize()
        XCTAssertEqual(settings.status, .notPaired)
        server.paired = true
        server.registrationError = URLError(.notConnectedToInternet)
        await settings.synchronize()
        XCTAssertEqual(settings.status, .unreachable)
        // An older server without the route cannot ring either.
        server.registrationError = ShannonAPIError.rejected(status: 404)
        await settings.synchronize()
        XCTAssertEqual(settings.status, .serverNotReady)
        XCTAssertEqual(ShannonIncomingCallCopy.toggleTitle, "シャノンからの着信を受ける")
        XCTAssertEqual(ShannonIncomingCallCopy.callerName, "シャノン")
    }
}

// MARK: Fakes

@MainActor
private final class FakeSystem: ShannonSystemCalling {
    enum Event: Equatable {
        case shown(UUID)
        case ended(UUID, ShannonCallEndReason)
    }

    var events: [Event] = []
    func showIncoming(_ id: UUID) { events.append(.shown(id)) }
    func end(_ id: UUID, reason: ShannonCallEndReason) { events.append(.ended(id, reason)) }
}

private final class FakeCallServer: ShannonIncomingCallServing, @unchecked Sendable {
    private let lock = NSLock()
    private let line: String
    private var _answers: [String] = []
    private var _reports: [String] = []
    private var _registrations: [String] = []
    var answerFails = false
    var reportFailures = 0
    var available = true
    var paired = true
    var registrationError: Error?

    init(line: String) { self.line = line }

    var answers: [String] { lock.withLock { _answers } }
    var reports: [String] { lock.withLock { _reports } }
    var registrations: [String] { lock.withLock { _registrations } }

    func incomingCallIsPaired() -> Bool { paired }

    func registerIncomingCalls(
        deviceToken: String, environment: ShannonPushEnvironmentDTO, bundleId: String, enabled: Bool
    ) async throws -> ShannonIncomingCallRegistrationResponseDTO {
        if let registrationError { throw registrationError }
        lock.withLock { _registrations.append("\(deviceToken):\(environment.rawValue):\(bundleId):\(enabled)") }
        return ShannonIncomingCallRegistrationResponseDTO(registered: true, enabled: enabled, available: available)
    }

    func answerIncomingCall(reachOutID: String, callID: String) async throws -> ShannonPrivateReachOutClaimDTO {
        lock.withLock { _answers.append("\(reachOutID)/\(callID)") }
        if answerFails { throw ShannonAPIError.rejected(status: 410) }
        return ShannonPrivateReachOutClaimDTO(
            status: "claimed", spoken: false, listenSeconds: 0,
            message: ShannonPrivateReachOutMessageDTO(id: reachOutID, threadId: "t1", content: line, createdAt: "2026-10-03T03:00:00.000Z")
        )
    }

    func reportIncomingCall(callID: String, outcome: ShannonIncomingCallOutcome) async throws {
        let fails = lock.withLock {
            _reports.append("\(callID):\(outcome.rawValue)")
            if reportFailures > 0 {
                reportFailures -= 1
                return true
            }
            return false
        }
        if fails { throw URLError(.timedOut) }
    }
}

@MainActor
private final class FakeCallSpeaker: ShannonReachOutSpeaking {
    var spoken: [String] = []
    var stops = 0
    /// The line goes on until it is stopped.
    var holds = false
    private var waiting: CheckedContinuation<Void, Never>?

    func speak(_ text: String, stillPrivate: @escaping @MainActor () -> Bool) async -> ShannonReachOutSpeechOutcome {
        // A call the owner answered is his to hear wherever it comes out.
        guard stillPrivate() else { return .notStarted }
        spoken.append(text)
        if holds {
            await withCheckedContinuation { waiting = $0 }
            return .cutShort
        }
        return .spoken
    }

    func stop() {
        stops += 1
        waiting?.resume()
        waiting = nil
    }
}

@MainActor
private final class FakeConversation: ShannonCallConversing {
    var isBusy = false
    var canListen = true
    var starts = true
    var prepared = 0
    var started: [String] = []
    var stops = 0
    var mutes: [Bool] = []
    var ended: (@MainActor () -> Void)?

    func prepareAudio() { prepared += 1 }

    func start(threadID: String) async -> Bool {
        guard starts else { return false }
        started.append(threadID)
        return true
    }

    func stop() {
        stops += 1
        ended?()
    }

    func setMuted(_ muted: Bool) { mutes.append(muted) }

    /// The conversation ends by itself.
    func end() { ended?() }
}
