import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonPrivateReachOutTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName = ""
    private let offer = ShannonPrivateReachOutOfferDTO(id: "r1", createdAt: "2026-10-02T03:00:00.000Z")
    private let start = Date(timeIntervalSince1970: 1_790_000_000)

    override func setUp() async throws {
        suiteName = "private-reach-out-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private struct World {
        let coordinator: ShannonPrivateReachOutCoordinator
        let client: FakeListeningClient
        let speaker: FakeSpeaker
        let listener: FakeListener
        let state: State
    }

    @MainActor
    private final class State {
        var isPrivate = true
        var inConversation = false
    }

    private func world() -> World {
        let client = FakeListeningClient()
        let coordinator = ShannonPrivateReachOutCoordinator(client: client, defaults: defaults)
        let speaker = FakeSpeaker()
        let listener = FakeListener()
        let state = State()
        coordinator.speaker = speaker
        coordinator.listener = listener
        coordinator.stillPrivate = { state.isPrivate }
        coordinator.isConversationActive = { state.inConversation }
        return World(coordinator: coordinator, client: client, speaker: speaker, listener: listener, state: state)
    }

    // MARK: Speaking

    func testItTakesTheClaimSpeaksReportsAndThenListensOnHerMessagesTalk() async {
        let w = world()
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.claims, ["r1"])
        XCTAssertEqual(w.speaker.spoken, ["ライ氏、いま何をしていますか。"])
        XCTAssertEqual(w.client.deliveries, [.spoken])
        XCTAssertEqual(w.listener.windows, [8])
        XCTAssertEqual(w.listener.threads, ["t1"])
        XCTAssertEqual(w.coordinator.activity, .idle)
    }

    func testTheSameMessageIsNeverSaidTwiceByThisDeviceAlsoAfterARelaunch() async {
        let w = world()
        await w.coordinator.handle(offer)
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.claims, ["r1"])
        XCTAssertEqual(w.speaker.spoken.count, 1)
        // A new launch reads what was handled from the device.
        let relaunched = ShannonPrivateReachOutCoordinator(client: w.client, defaults: defaults)
        let speaker = FakeSpeaker()
        relaunched.speaker = speaker
        relaunched.stillPrivate = { true }
        await relaunched.handle(offer)
        XCTAssertEqual(w.client.claims, ["r1"])
        XCTAssertEqual(speaker.spoken, [])
    }

    func testAnOfferOfAMessageItAlreadyTookIsAnsweredWithWhatItDidAndNeverSaidAgain() async {
        let w = world()
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.deliveries, [.spoken])
        // The server did not get the report and offers the message again.
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.speaker.spoken.count, 1)
        XCTAssertEqual(w.client.claims, ["r1"])
        XCTAssertEqual(w.client.deliveries, [.spoken, .spoken])

        let given = world()
        given.state.isPrivate = true
        var asked = 0
        given.coordinator.stillPrivate = { asked += 1; return asked == 1 }
        let other = ShannonPrivateReachOutOfferDTO(id: "r2", createdAt: "2026-10-02T03:10:00.000Z")
        await given.coordinator.handle(other)
        await given.coordinator.handle(other)
        XCTAssertEqual(given.client.deliveries, [.notSpoken, .notSpoken])
        XCTAssertEqual(given.speaker.spoken, [])
    }

    func testAReportTheServerDidNotGetIsKeptAndSentAgainAlsoAfterARelaunch() async {
        let w = world()
        w.client.deliveryFailure = URLError(.notConnectedToInternet)
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.speaker.spoken.count, 1)
        XCTAssertEqual(w.client.deliveries, [])
        XCTAssertEqual(w.coordinator.unacknowledged, ["r1"])
        // He still gets his few seconds to answer: the microphone does not wait for the report.
        XCTAssertEqual(w.listener.windows, [8])

        // The app is closed and opened again; the network is back.
        w.client.deliveryFailure = nil
        let relaunched = ShannonPrivateReachOutCoordinator(client: w.client, defaults: defaults)
        await relaunched.flushReports()
        XCTAssertEqual(w.client.deliveries, [.spoken])
        XCTAssertEqual(relaunched.unacknowledged, [])
        await relaunched.flushReports()
        XCTAssertEqual(w.client.deliveries, [.spoken])
    }

    func testAReportTheServerRefusesForGoodIsNotRepeated() async {
        let w = world()
        w.client.deliveryFailure = ShannonAPIError.rejected(status: 409)
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.coordinator.unacknowledged, [])
    }

    func testAMessageWhoseFateIsUnknownCountsAsSpoken() async {
        // The app stopped after taking the message and before it could report: nobody may say it again.
        defaults.set(["r1"], forKey: ShannonPrivateReachOutCoordinator.handledDefaultsKey)
        let w = world()
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.claims, [])
        XCTAssertEqual(w.speaker.spoken, [])
        XCTAssertEqual(w.client.deliveries, [.spoken])
    }

    func testAnotherSurfaceHoldingItMeansThisAppSaysNothing() async {
        let w = world()
        w.client.claimFailure = ShannonAPIError.rejected(status: 409)
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.speaker.spoken, [])
        XCTAssertEqual(w.client.deliveries, [])
        XCTAssertEqual(w.listener.windows, [])
    }

    func testAClaimThatWasAlreadySpokenIsNotSpokenAgain() async {
        let w = world()
        w.client.claim = ShannonPrivateReachOutClaimDTO(status: "held", spoken: true, listenSeconds: 8, message: w.client.claim.message)
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.speaker.spoken, [])
        XCTAssertEqual(w.client.deliveries, [])
    }

    // MARK: Never aloud where others could hear

    func testNothingIsClaimedOrSaidWhileTheSoundIsNotPrivate() async {
        let w = world()
        w.state.isPrivate = false
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.claims, [])
        XCTAssertEqual(w.speaker.spoken, [])
        // Once the earphones are back the same offer is taken.
        w.state.isPrivate = true
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.speaker.spoken.count, 1)
    }

    func testEarphonesLeavingBetweenTheClaimAndTheFirstSoundGivesTheMessageBackUnspoken() async {
        let w = world()
        var asked = 0
        // Private when the offer arrives, no longer once the claim is back.
        w.coordinator.stillPrivate = { asked += 1; return asked == 1 }
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.claims, ["r1"])
        XCTAssertEqual(w.speaker.spoken, [])
        XCTAssertEqual(w.client.deliveries, [.notSpoken])
        XCTAssertEqual(w.listener.windows, [])
    }

    func testEarphonesLeavingWhileSheSpeaksStopsItAndTheMicrophoneStaysClosed() async {
        let w = world()
        w.speaker.whileSpeaking = { w.state.isPrivate = false }
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.speaker.spoken.count, 1)
        // He heard part of it: nobody says it again, and nothing listens on an output that is not private.
        XCTAssertEqual(w.client.deliveries, [.spoken])
        XCTAssertEqual(w.listener.windows, [])
    }

    func testAVoiceThatCouldNotBeProducedLeavesTheMessageAsText() async {
        let w = world()
        w.speaker.outcome = .failed
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.deliveries, [.notSpoken])
        XCTAssertEqual(w.listener.windows, [])
    }

    // MARK: Never into a conversation

    func testSheDoesNotSpeakIntoAConversation() async {
        let w = world()
        w.state.inConversation = true
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.claims, [])
        XCTAssertEqual(w.speaker.spoken, [])
    }

    func testAConversationThatBeganAfterTheClaimGivesTheMessageBack() async {
        let w = world()
        var asked = 0
        w.coordinator.isConversationActive = { asked += 1; return asked > 1 }
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.speaker.spoken, [])
        XCTAssertEqual(w.client.deliveries, [.notSpoken])
    }

    func testAZeroWindowSpeaksWithoutOpeningTheMicrophone() async {
        let w = world()
        w.client.claim = ShannonPrivateReachOutClaimDTO(status: "claimed", spoken: false, listenSeconds: 0, message: w.client.claim.message)
        await w.coordinator.handle(offer)
        XCTAssertEqual(w.client.deliveries, [.spoken])
        XCTAssertEqual(w.listener.windows, [])
    }

    // MARK: Waiting for the answer

    /// Plays a scripted call: each look takes the next observation, and every sleep moves the clock.
    @MainActor
    private final class ScriptedCall {
        var observations: [ShannonAnswerObservation]
        var clock: Date
        private(set) var looks = 0
        init(_ observations: [ShannonAnswerObservation], start: Date) {
            self.observations = observations
            clock = start
        }
        func observe() -> ShannonAnswerObservation {
            defer { looks += 1 }
            return observations[min(looks, observations.count - 1)]
        }
    }

    private func wait(_ observations: [ShannonAnswerObservation], seconds: Int = 2) async -> (ShannonAnswerOutcome, TimeInterval) {
        let call = ScriptedCall(observations, start: start)
        let outcome = await ShannonAnswerWait.run(
            seconds: seconds, observe: { call.observe() }, now: { call.clock },
            sleep: { interval in call.clock = call.clock.addingTimeInterval(interval); return true }
        )
        return (outcome, call.clock.timeIntervalSince(start))
    }

    private func look(_ call: ShannonAnswerCallState, input: Bool = false, sound: Bool = false, isPrivate: Bool = true) -> ShannonAnswerObservation {
        ShannonAnswerObservation(call: call, hasOwnerInput: input, hearsSound: sound, isPrivate: isPrivate)
    }

    func testTheWindowOpensOnlyOnceTheCallIsConnectedAndSilenceEndsIt() async {
        // Three looks while connecting, then a live call in which nothing is said.
        let (outcome, elapsed) = await wait([look(.starting), look(.starting), look(.starting), look(.live)])
        XCTAssertEqual(outcome, .silent)
        // 0.3 s of connecting, then the whole two-second window.
        XCTAssertEqual(elapsed, 0.3 + 2, accuracy: 0.11)
    }

    func testACallThatHasNotStartedOrDoesNotConnectIsGivenUp() async {
        let notStarted = await wait([look(.ended)])
        XCTAssertEqual(notStarted.0, .unavailable)
        XCTAssertEqual(notStarted.1, 0)
        let (outcome, elapsed) = await wait([look(.starting)])
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertEqual(elapsed, ShannonAnswerWait.connectTimeout, accuracy: 0.11)
        // A call that fails while the window is open.
        let failed = await wait([look(.live), look(.live), look(.ended)])
        XCTAssertEqual(failed.0, .unavailable)
    }

    func testAnUtteranceMakesItAConversation() async {
        let (outcome, elapsed) = await wait([look(.live), look(.live, sound: true), look(.live, sound: true), look(.live, input: true)])
        XCTAssertEqual(outcome, .answered)
        XCTAssertEqual(elapsed, 0.3, accuracy: 0.01)
    }

    func testACallWhoseSoundIsNoLongerOnlyHisIsGivenUpEvenIfHeSpoke() async {
        let first = await wait([look(.live, isPrivate: false)])
        XCTAssertEqual(first.0, .unavailable)
        let later = await wait([look(.live), look(.live, input: true, isPrivate: false)])
        XCTAssertEqual(later.0, .unavailable)
    }

    func testASentenceBegunJustBeforeTheEndIsWaitedFor() async {
        // Quiet for 1.8 s, then sound until he is transcribed at 3.0 s, past the two-second window.
        var looks = Array(repeating: look(.live), count: 18)
        looks += Array(repeating: look(.live, sound: true), count: 12)
        looks.append(look(.live, input: true))
        let (outcome, elapsed) = await wait(looks)
        XCTAssertEqual(outcome, .answered)
        XCTAssertEqual(elapsed, 3.0, accuracy: 0.11)
    }

    // MARK: The answer window

    func testTheWindowIsOpenForItsSecondsAndASoundJustBeforeTheEndKeepsItOpenALittle() {
        var window = ShannonAnswerWindow(opensAt: start, seconds: 8)
        XCTAssertTrue(window.isOpen(at: start.addingTimeInterval(7.9)))
        XCTAssertFalse(window.isOpen(at: start.addingTimeInterval(8)))
        window.heardSound(at: start.addingTimeInterval(7.5))
        XCTAssertTrue(window.isOpen(at: start.addingTimeInterval(8.5)))
        XCTAssertFalse(window.isOpen(at: start.addingTimeInterval(9.1)))
        // Continuous sound cannot hold the microphone open for ever.
        for step in stride(from: 7.5, through: 30, by: 0.5) { window.heardSound(at: start.addingTimeInterval(step)) }
        XCTAssertTrue(window.isOpen(at: start.addingTimeInterval(15.9)))
        XCTAssertFalse(window.isOpen(at: start.addingTimeInterval(16)))
    }

    func testSilenceForTheWholeWindowIsNoAnswer() {
        var detector = ShannonAnswerDetector(opensAt: start, seconds: 8)
        var decision = ShannonAnswerDetector.Decision.waiting
        for step in stride(from: 0.0, through: 8.1, by: 0.05) {
            decision = detector.observe(level: -58, at: start.addingTimeInterval(step))
            if decision != .waiting { break }
        }
        XCTAssertEqual(decision, .silent)
        XCTAssertNil(detector.speechStartedAt)
    }

    func testSpeechThenQuietIsAnAnswer() {
        var detector = ShannonAnswerDetector(opensAt: start, seconds: 8)
        var decision = ShannonAnswerDetector.Decision.waiting
        var endedAt = 0.0
        for step in stride(from: 0.0, through: 20, by: 0.05) {
            // Quiet for two seconds, three seconds of speech, then quiet.
            let level: Float = step >= 2 && step < 5 ? -18 : -58
            decision = detector.observe(level: level, at: start.addingTimeInterval(step))
            if decision != .waiting { endedAt = step; break }
        }
        XCTAssertEqual(decision, .answered)
        XCTAssertEqual(detector.speechStartedAt, start.addingTimeInterval(2))
        XCTAssertEqual(endedAt, 5 + ShannonAnswerDetector.trailingSilence - 0.05, accuracy: 0.11)
    }

    func testAClickIsNotAnAnswerAndALongAnswerIsCut() {
        var click = ShannonAnswerDetector(opensAt: start, seconds: 4)
        var decision = ShannonAnswerDetector.Decision.waiting
        for step in stride(from: 0.0, through: 6, by: 0.05) {
            let level: Float = step >= 1 && step < 1.1 ? -10 : -58
            decision = click.observe(level: level, at: start.addingTimeInterval(step))
            if decision != .waiting { break }
        }
        XCTAssertEqual(decision, .silent)

        var long = ShannonAnswerDetector(opensAt: start, seconds: 4)
        var endedAt = 0.0
        for step in stride(from: 0.0, through: 60, by: 0.05) {
            decision = long.observe(level: step >= 1 ? -15 : -58, at: start.addingTimeInterval(step))
            if decision != .waiting { endedAt = step; break }
        }
        XCTAssertEqual(decision, .answered)
        XCTAssertEqual(endedAt, 1 + ShannonAnswerDetector.maximumAnswer, accuracy: 0.11)
    }

    func testTheSpeechLevelFollowsTheRoomsNoiseWithinBounds() {
        var quiet = ShannonAnswerDetector(opensAt: start, seconds: 4)
        _ = quiet.observe(level: -70, at: start)
        XCTAssertEqual(quiet.threshold, ShannonAnswerDetector.quietestThreshold)
        var noisy = ShannonAnswerDetector(opensAt: start, seconds: 4)
        _ = noisy.observe(level: -20, at: start)
        XCTAssertEqual(noisy.threshold, ShannonAnswerDetector.loudestThreshold)
        var room = ShannonAnswerDetector(opensAt: start, seconds: 4)
        _ = room.observe(level: -50, at: start)
        XCTAssertEqual(room.threshold, -38)
    }

    // MARK: Her voice

    func testSpeechPCMIsConvertedSampleForSample() throws {
        let format = try XCTUnwrap(ShannonEarphoneSpeaker.playbackFormat)
        let samples: [Int16] = [0, 16_384, -16_384, 32_767, -32_768]
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        let buffer = try XCTUnwrap(ShannonEarphoneSpeaker.buffer(from: data, format: format))
        XCTAssertEqual(buffer.frameLength, 5)
        let floats = try XCTUnwrap(buffer.floatChannelData?[0])
        XCTAssertEqual(floats[1], 0.5, accuracy: 0.0001)
        XCTAssertEqual(floats[2], -0.5, accuracy: 0.0001)
        XCTAssertEqual(floats[4], -1, accuracy: 0.0001)
        XCTAssertNil(ShannonEarphoneSpeaker.buffer(from: Data([1]), format: format))
        XCTAssertNil(ShannonEarphoneSpeaker.buffer(from: Data(), format: format))
    }

    func testASpeakerNeverStartsWhenTheSoundIsNotPrivateAndAsksNoServerForAVoice() async {
        var requests = 0
        let speaker = ShannonEarphoneSpeaker(
            streamSpeech: { _, _, _ in requests += 1; throw URLError(.badServerResponse) },
            monitor: FakeRouteMonitor(outputs: []), defaults: defaults
        )
        let notPrivate = await speaker.speak("ライ氏、こんにちは。") { false }
        XCTAssertEqual(notPrivate, .notStarted)
        XCTAssertEqual(requests, 0)
        let failed = await speaker.speak("ライ氏、こんにちは。") { true }
        XCTAssertEqual(failed, .failed)
        XCTAssertEqual(requests, 1)
    }

    func testSettingsWordingSaysWhatIsOffTheBatteryCostAndThatQuittingStopsStandby() {
        XCTAssertEqual(ShannonPrivateListeningCopy.speaksTitle, "イヤホンのときは声で話しかける")
        XCTAssertEqual(ShannonPrivateListeningCopy.standbyTitle, "ほかのアプリを使っている間も待機する")
        XCTAssertTrue(ShannonPrivateListeningCopy.speaksExplanation.contains("最初はオフです"))
        XCTAssertTrue(ShannonPrivateListeningCopy.standbyExplanation.contains("電池を多く使います"))
        XCTAssertTrue(ShannonPrivateListeningCopy.standbyExplanation.contains("上にスワイプして終了したときも待機は止まります"))
        XCTAssertTrue(ShannonPrivateListeningCopy.standbyExplanation.contains("イヤホンを外すと待機は止まり"))
        XCTAssertEqual(ShannonPrivateListeningCopy.standbyStatus(.standingBy, enabled: true), "待機中です")
        XCTAssertEqual(ShannonPrivateListeningCopy.standbyStatus(.stopped, enabled: true), "待機が止まりました。このアプリを開くと再開します")
        XCTAssertEqual(ShannonPrivateListeningCopy.standbyStatus(.standingBy, enabled: false), "オフ")
        XCTAssertEqual(ShannonPrivateListeningCopy.speaksStatus(enabled: true, speaksNow: false), "イヤホンをつなぐと話しかけます")
    }
}
