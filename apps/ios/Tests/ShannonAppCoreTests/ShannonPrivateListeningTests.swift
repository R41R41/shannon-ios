import XCTest
#if os(macOS)
import CoreAudio
#endif
@testable import ShannonAppCore

@MainActor
final class ShannonPrivateListeningTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName = ""
    private let start = Date(timeIntervalSince1970: 1_790_000_000)

    private let airPods = ShannonAudioOutput(id: "AA:BB:CC:11:22:33", name: "AirPods Pro", kind: .bluetooth)
    private let speaker = ShannonAudioOutput(id: "DD:EE:FF:44:55:66", name: "居間のスピーカー", kind: .bluetooth)
    private let wired = ShannonAudioOutput(id: "Wired Headphones", name: "ヘッドホン", kind: .wiredHeadphones)
    private let builtIn = ShannonAudioOutput(id: "Speaker", name: "スピーカー", kind: .builtInSpeaker)

    override func setUp() async throws {
        suiteName = "private-listening-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func makeModel(
        client: FakeListeningClient?, monitor: FakeRouteMonitor, activity: Date? = nil, runsInBackground: Bool = true
    ) -> ShannonPrivateListeningModel {
        ShannonPrivateListeningModel(
            client: client, monitor: monitor, defaults: defaults, kind: .mac, runsInBackground: runsInBackground,
            now: { [start] in start }, ownerActivity: { activity }, sleep: { _ in }
        )
    }

    // MARK: Who can hear

    func testWiredHeadphonesArePrivateWithoutRegistration() {
        XCTAssertTrue(ShannonPrivateListeningJudge.isPrivate(route: [wired], registered: []))
    }

    func testBluetoothIsPrivateOnlyWhenThatDeviceWasRegistered() {
        let registered = [ShannonRegisteredEarphones(id: airPods.id, name: airPods.name, registeredAt: start)]
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [airPods], registered: []))
        XCTAssertTrue(ShannonPrivateListeningJudge.isPrivate(route: [airPods], registered: registered))
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [speaker], registered: registered))
    }

    func testTheIdentityDecidesNotTheName() {
        let registered = [ShannonRegisteredEarphones(id: airPods.id, name: "AirPods Pro", registeredAt: start)]
        let sameName = ShannonAudioOutput(id: "99:99:99:99:99:99", name: "AirPods Pro", kind: .bluetooth)
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [sameName], registered: registered))
    }

    func testSpeakersOtherOutputsAndAnEmptyRouteAreNeverPrivate() {
        let everything = [builtIn, ShannonAudioOutput(id: "x", name: "AirPlay", kind: .other)].map {
            ShannonRegisteredEarphones(id: $0.id, name: $0.name, registeredAt: start)
        }
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [builtIn], registered: everything))
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [ShannonAudioOutput(id: "x", name: "AirPlay", kind: .other)], registered: everything))
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [], registered: everything))
    }

    func testOneOutputThatIsNotPrivateMakesTheWholeRouteNotPrivate() {
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [wired, builtIn], registered: []))
    }

    func testAWiredOutputIsNotPrivateOnceTheOwnerSaysHisJackHasSpeakersOnIt() async {
        XCTAssertFalse(ShannonPrivateListeningJudge.isPrivate(route: [wired], registered: [], wiredCountsAsPrivate: false))
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        XCTAssertTrue(model.wiredCountsAsPrivate)
        await model.report()
        XCTAssertEqual(client.transitions, [true])
        model.setWiredCountsAsPrivate(false)
        XCTAssertFalse(model.isPrivatelyListening)
        await model.report()
        XCTAssertEqual(client.transitions, [true, false])
        // Remembered on the device.
        XCTAssertFalse(makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired])).wiredCountsAsPrivate)
        XCTAssertEqual(
            ShannonPrivateListeningCopy.outputDescription(wired, registered: [], wiredCountsAsPrivate: false),
            "有線の出口・ヘッドホンとして扱いません"
        )
    }

    func testTheSameEarphonesAreRecognisedUnderEitherBluetoothProfile() {
        XCTAssertEqual(ShannonAudioOutput.normalizedPortUID("AA:BB:CC:11:22:33-tacl"), "AA:BB:CC:11:22:33")
        XCTAssertEqual(ShannonAudioOutput.normalizedPortUID("AA:BB:CC:11:22:33-tsco"), "AA:BB:CC:11:22:33")
        XCTAssertEqual(ShannonAudioOutput.normalizedPortUID("Wired Headphones"), "Wired Headphones")
        XCTAssertEqual(ShannonAudioOutput.normalizedPortUID("usb-audio-1234"), "usb-audio-1234")
        XCTAssertEqual(ShannonAudioOutput.normalizedDeviceUID("80-99-E7-CA-23-F8:output"), "80-99-E7-CA-23-F8")
        XCTAssertEqual(ShannonAudioOutput.normalizedDeviceUID("BuiltInSpeakerDevice"), "BuiltInSpeakerDevice")
    }

#if os(macOS)
    func testMacOutputsAreClassifiedByTransportAndJack() {
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: kAudioDeviceTransportTypeBuiltIn, uid: "BuiltInSpeakerDevice", dataSource: 0x6973_706B), .builtInSpeaker)
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: kAudioDeviceTransportTypeBuiltIn, uid: "BuiltInHeadphoneOutputDevice", dataSource: nil), .wiredHeadphones)
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: kAudioDeviceTransportTypeBuiltIn, uid: "AppleHDAEngineOutput:1B,0,1,1:0", dataSource: 0x6864_706E), .wiredHeadphones)
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: kAudioDeviceTransportTypeBluetooth, uid: "80-99-E7-CA-23-F8:output", dataSource: nil), .bluetooth)
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: kAudioDeviceTransportTypeUSB, uid: "usb", dataSource: nil), .usb)
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: kAudioDeviceTransportTypeAggregate, uid: "agg", dataSource: nil), .other)
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: kAudioDeviceTransportTypeAirPlay, uid: "air", dataSource: nil), .other)
        XCTAssertEqual(ShannonCoreAudioOutput.kind(transport: nil, uid: "unknown", dataSource: nil), .other)
    }
#endif

    // MARK: Registry

    func testRegisteringKeepsTheEarphonesOnThisDeviceAndRemovingForgetsThem() {
        let registry = ShannonEarphoneRegistry(defaults: defaults)
        XCTAssertEqual(registry.load(), [])
        registry.register(airPods, at: start)
        registry.register(airPods, at: start.addingTimeInterval(60))
        XCTAssertEqual(ShannonEarphoneRegistry(defaults: defaults).load().map(\.id), [airPods.id])
        // Wired headphones and speakers are not something to register.
        registry.register(wired, at: start)
        registry.register(builtIn, at: start)
        XCTAssertEqual(registry.load().map(\.id), [airPods.id])
        XCTAssertEqual(registry.remove(id: airPods.id), [])
        XCTAssertEqual(ShannonEarphoneRegistry(defaults: defaults).load(), [])
    }

    func testOnlyAnUnregisteredBluetoothOrUSBOutputIsOfferedForRegistration() {
        let monitor = FakeRouteMonitor(outputs: [airPods])
        let model = makeModel(client: nil, monitor: monitor)
        XCTAssertEqual(model.registrableOutput, airPods)
        model.registerCurrentOutput()
        XCTAssertNil(model.registrableOutput)
        XCTAssertEqual(model.registered.map(\.name), ["AirPods Pro"])
        for outputs in [[wired], [builtIn], [], [airPods, speaker]] {
            monitor.outputs = outputs
            model.refreshRoute()
            XCTAssertNil(model.registrableOutput)
        }
    }

    // MARK: Telling the server

    func testNothingIsSentWhileTheSoundIsNotPrivate() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [builtIn]))
        await model.report()
        await model.report()
        XCTAssertEqual(client.reports, [])
        XCTAssertEqual(model.status, .notListening)
    }

    func testUnregisteredBluetoothIsNotReportedAndRegisteringItStartsTheReport() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [airPods]), activity: start.addingTimeInterval(-30))
        await model.report()
        XCTAssertEqual(client.reports, [])
        model.registerCurrentOutput()
        await model.report()
        XCTAssertEqual(client.transitions, [true])
        XCTAssertEqual(client.reports.first?.kind, .mac)
        XCTAssertEqual(client.reports.first?.scopeKey, "owner-a")
        XCTAssertEqual(client.reports.first?.ownerActiveAt, ISO8601DateFormatter().string(from: start.addingTimeInterval(-30)))
        XCTAssertEqual(model.status, .reported)
    }

    func testARouteChangeToASpeakerWithdrawsTheReportOnce() async {
        let client = FakeListeningClient()
        let monitor = FakeRouteMonitor(outputs: [wired])
        let model = makeModel(client: client, monitor: monitor)
        await model.report()
        monitor.outputs = [builtIn]
        XCTAssertFalse(model.refreshRoute())
        await model.report()
        await model.report()
        XCTAssertEqual(client.transitions, [true, false])
        XCTAssertNil(client.reports.last?.ownerActiveAt)
        XCTAssertEqual(model.status, .notListening)
    }

    func testAFriendInTheCallIsNeverReportedAsPrivate() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        model.othersPresent = true
        await model.report()
        XCTAssertFalse(model.isPrivatelyListening)
        XCTAssertEqual(client.reports.filter(\.listening), [])
        XCTAssertEqual(model.status, .othersPresent)
        model.othersPresent = false
        await model.report()
        XCTAssertEqual(client.reports.last?.listening, true)
        // A friend joins while it is reported: it is withdrawn.
        model.othersPresent = true
        await model.report()
        XCTAssertEqual(client.reports.last?.listening, false)
    }

    func testAnIPhoneAppThatLeavesTheForegroundWithdrawsItsReportUnlessItStandsBy() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]), runsInBackground: false)
        await model.report()
        model.isInForeground = false
        await model.report()
        XCTAssertEqual(client.reports.map(\.listening).last, false)
        XCTAssertEqual(model.status, .notListening)
        // Standing by, it runs in the background and goes on reporting.
        model.isStandingBy = true
        await model.report()
        XCTAssertEqual(client.reports.map(\.listening).last, true)
        model.isStandingBy = false
        await model.report()
        XCTAssertEqual(client.reports.map(\.listening).last, false)
    }

    func testTheMacAppReportsWhetherOrNotItIsInFront() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        model.isInForeground = false
        await model.report()
        XCTAssertEqual(client.reports.map(\.listening).last, true)
    }

    // MARK: Speaking

    func testSpeakingIsOffUntilTheOwnerSwitchesItOnAndIsRemembered() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        XCTAssertFalse(model.speaksEnabled)
        await model.report()
        XCTAssertEqual(client.reports.last?.speaks, false)
        model.setSpeaksEnabled(true)
        await model.report()
        XCTAssertEqual(client.reports.last?.speaks, true)
        XCTAssertTrue(makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired])).speaksEnabled)
    }

    func testStandbyIsWantedOnlyWithBothSwitchesRegisteredEarphonesAndNobodyElse() async {
        let monitor = FakeRouteMonitor(outputs: [airPods])
        let model = makeModel(client: FakeListeningClient(), monitor: monitor, runsInBackground: false)
        XCTAssertFalse(model.standbyEnabled)
        model.registerCurrentOutput()
        XCTAssertFalse(model.wantsStandby)
        model.setSpeaksEnabled(true)
        XCTAssertFalse(model.wantsStandby)
        model.setStandbyEnabled(true)
        // Not before the server said it has messages said through earphones.
        XCTAssertFalse(model.wantsStandby)
        await model.report()
        XCTAssertTrue(model.serverDelivers)
        XCTAssertTrue(model.wantsStandby)
        model.othersPresent = true
        XCTAssertFalse(model.wantsStandby)
        model.othersPresent = false
        // The earphones disconnect: the sound would come out of the speaker.
        monitor.outputs = [builtIn]
        model.evaluate()
        XCTAssertFalse(model.wantsStandby)
        monitor.outputs = [speaker]
        model.evaluate()
        XCTAssertFalse(model.wantsStandby)
    }

    func testStandbyIsNotWantedInLowPowerModeOrWhileTheServerRefusesReports() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]), runsInBackground: false)
        model.setSpeaksEnabled(true)
        model.setStandbyEnabled(true)
        await model.report()
        XCTAssertTrue(model.wantsStandby)
        model.isLowPowerMode = true
        XCTAssertFalse(model.wantsStandby)
        model.isLowPowerMode = false
        XCTAssertEqual(ShannonPrivateListeningCopy.standbyStatus(.off, enabled: true, lowPowerMode: true), "省電力モード中は待機しません")

        // A server that refuses: standing by would only use battery. It must not start again by itself
        // (standing by makes the app report, which is refused again).
        client.failure = ShannonAPIError.rejected(status: 403)
        await model.report()
        XCTAssertTrue(model.serverRefuses)
        XCTAssertFalse(model.wantsStandby)
        model.isInForeground = false
        await model.report()
        XCTAssertFalse(model.wantsStandby)
        // Back in front with a server that answers: standby is wanted again.
        client.failure = nil
        model.isInForeground = true
        await model.report()
        XCTAssertFalse(model.serverRefuses)
        XCTAssertTrue(model.wantsStandby)
    }

    func testStandbyIsNotWantedWhileTheServerHasNothingToSayThroughEarphones() async {
        let client = FakeListeningClient()
        client.delivers = false
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]), runsInBackground: false)
        model.setSpeaksEnabled(true)
        model.setStandbyEnabled(true)
        await model.report()
        // An older server, or the feature switched off there: the report is taken, nothing would ever be offered.
        XCTAssertEqual(model.status, .reported)
        XCTAssertFalse(model.serverDelivers)
        XCTAssertFalse(model.wantsStandby)
        XCTAssertEqual(
            ShannonPrivateListeningCopy.speaksStatus(enabled: true, speaksNow: true, serverDelivers: false),
            "サーバー側で声での話しかけが止められています"
        )
        client.delivers = true
        await model.report()
        XCTAssertTrue(model.wantsStandby)
    }

    func testARevokedConnectionCountsAsNotPairedAndStopsStandby() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]), runsInBackground: false)
        model.setSpeaksEnabled(true)
        model.setStandbyEnabled(true)
        await model.report()
        XCTAssertTrue(model.wantsStandby)
        XCTAssertTrue(model.canBeOffered)
        client.failure = ShannonAPIError.rejected(status: 401)
        await model.report()
        XCTAssertEqual(model.status, .notPaired)
        XCTAssertFalse(model.wantsStandby)
        XCTAssertFalse(model.canBeOffered)
    }

    func testAReportOfWhatWasDoneThatDidNotArriveGoesOutWithALaterHeartbeat() async {
        let client = FakeListeningClient()
        client.offer = ShannonPrivateReachOutOfferDTO(id: "r1", createdAt: "2026-10-02T03:00:00.000Z")
        client.deliveryFailure = URLError(.timedOut)
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        let speaker = FakeSpeaker()
        model.reachOuts.speaker = speaker
        model.setSpeaksEnabled(true)
        await model.report()
        for _ in 0..<50 where model.reachOuts.unacknowledged.isEmpty { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(speaker.spoken.count, 1)
        XCTAssertEqual(model.reachOuts.unacknowledged, ["r1"])
        XCTAssertEqual(client.deliveries, [])
        // The network is back; the server no longer offers the message (it is past being spoken).
        client.deliveryFailure = nil
        client.offer = nil
        await model.report()
        for _ in 0..<50 where !model.reachOuts.unacknowledged.isEmpty { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(client.deliveries, [.spoken])
        XCTAssertEqual(model.reachOuts.unacknowledged, [])
        XCTAssertEqual(speaker.spoken.count, 1)
    }

    func testTheStandbyIsToldAtOnceWhenTheRouteChanges() {
        let monitor = FakeRouteMonitor(outputs: [wired])
        let model = makeModel(client: nil, monitor: monitor)
        var evaluations = 0
        model.stateEvaluated = { evaluations += 1 }
        model.refreshRoute()
        XCTAssertEqual(evaluations, 0)
        monitor.outputs = [builtIn]
        XCTAssertFalse(model.refreshRoute())
        XCTAssertEqual(evaluations, 1)
    }

    func testAnOfferIsHandedToTheCoordinatorOnlyWhileTheAppSpeaks() async {
        let client = FakeListeningClient()
        client.offer = ShannonPrivateReachOutOfferDTO(id: "r1", createdAt: "2026-10-02T03:00:00.000Z")
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        let speaker = FakeSpeaker()
        model.reachOuts.speaker = speaker
        await model.report()
        await Task.yield()
        XCTAssertEqual(client.claims, [])
        model.setSpeaksEnabled(true)
        await model.report()
        for _ in 0..<20 where speaker.spoken.isEmpty { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(client.claims.first, "r1")
        XCTAssertEqual(speaker.spoken, ["ライ氏、いま何をしていますか。"])
    }

    func testAnUnpairedDeviceSendsNothing() async {
        let client = FakeListeningClient()
        client.scopeKey = nil
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        await model.report()
        XCTAssertEqual(client.reports, [])
        XCTAssertEqual(model.status, .notPaired)
    }

    func testServerRefusalsAreShownAndNotRepeatedEveryFewSeconds() async {
        for (status, expected) in [(404, ShannonPrivateListeningStatus.unsupported), (403, .refused)] {
            let client = FakeListeningClient()
            client.failure = ShannonAPIError.rejected(status: status)
            let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
            await model.report()
            XCTAssertEqual(model.status, expected)
        }
        let client = FakeListeningClient()
        client.failure = URLError(.notConnectedToInternet)
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        await model.report()
        XCTAssertEqual(model.status, .failed)
    }

    func testWithdrawSaysNoLongerOnlyWhenItWasReported() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        await model.withdraw()
        XCTAssertEqual(client.reports, [])
        await model.report()
        await model.withdraw()
        XCTAssertEqual(client.transitions, [true, false])
    }

    func testAReportNeverCarriesADeviceNameOrIdentifier() throws {
        let report = ShannonPrivateListeningReportDTO(scopeKey: "owner-a", kind: .iphone, listening: true, ownerActiveAt: start)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["scopeKey", "kind", "listening", "speaks", "ownerActiveAt"])
        let off = ShannonPrivateListeningReportDTO(scopeKey: "owner-a", kind: .iphone, listening: false, ownerActiveAt: start)
        let offJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(off)) as? [String: Any])
        XCTAssertEqual(Set(offJSON.keys), ["scopeKey", "kind", "listening"])
    }

    func testStatusAndOutputWordingIsNeutralJapanese() {
        XCTAssertEqual(ShannonPrivateListeningCopy.statusText(.reported), "「自分だけに聞こえる」と伝えています")
        XCTAssertEqual(ShannonPrivateListeningCopy.statusText(.othersPresent), "「友人も一緒」のあいだは伝えません")
        XCTAssertEqual(ShannonPrivateListeningCopy.outputDescription(airPods, registered: []), "未登録・イヤホンかスピーカーか区別できません")
        XCTAssertEqual(ShannonPrivateListeningCopy.outputDescription(wired, registered: []), "有線のヘッドホン・自分だけに聞こえます")
        XCTAssertEqual(ShannonPrivateListeningCopy.registerTitle("AirPods Pro"), "「AirPods Pro」をイヤホンとして登録")
    }
}

@MainActor
final class FakeRouteMonitor: ShannonAudioRouteMonitoring {
    var outputs: [ShannonAudioOutput]
    init(outputs: [ShannonAudioOutput]) { self.outputs = outputs }
    func currentOutputs() -> [ShannonAudioOutput] { outputs }
    func changes() -> AsyncStream<Void> { AsyncStream { $0.finish() } }
}

final class FakeListeningClient: ShannonPrivateListeningServing, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [ShannonPrivateListeningReportDTO] = []
    var scopeKey: String? = "owner-a"
    var failure: Error?

    var reports: [ShannonPrivateListeningReportDTO] { lock.withLock { stored } }

    /// What the server was told, without a repeat of the same answer: the model may renew a report.
    var transitions: [Bool] {
        reports.map(\.listening).reduce(into: [Bool]()) { result, value in
            if result.last != value { result.append(value) }
        }
    }

    /// What the server offers to an app that says it speaks.
    var offer: ShannonPrivateReachOutOfferDTO?
    /// Whether the server has messages said through earphones (false: an older server, or switched off there).
    var delivers = true
    var claimFailure: Error?
    /// A delivery report that does not reach the server.
    var deliveryFailure: Error?
    var claim = ShannonPrivateReachOutClaimDTO(
        status: "claimed", spoken: false, listenSeconds: 8,
        message: .init(id: "r1", threadId: "t1", content: "ライ氏、いま何をしていますか。", reason: "wonder", createdAt: "2026-10-02T03:00:00.000Z")
    )
    private var claimed: [String] = []
    private var outcomes: [ShannonPrivateReachOutOutcome] = []
    var claims: [String] { lock.withLock { claimed } }
    var deliveries: [ShannonPrivateReachOutOutcome] { lock.withLock { outcomes } }

    func privateListeningScopeKey() -> String? { scopeKey }

    func reportPrivateListening(_ report: ShannonPrivateListeningReportDTO) async throws -> ShannonPrivateListeningResponseDTO {
        lock.withLock { stored.append(report) }
        if let failure { throw failure }
        return ShannonPrivateListeningResponseDTO(
            listening: report.listening, since: nil, expiresAt: nil, pollAfterSeconds: 15,
            speaks: delivers && report.listening ? report.speaks : nil,
            reachOut: delivers && report.speaks == true ? offer : nil
        )
    }

    func claimPrivateReachOut(id: String) async throws -> ShannonPrivateReachOutClaimDTO {
        lock.withLock { claimed.append(id) }
        if let claimFailure { throw claimFailure }
        return claim
    }

    func reportPrivateReachOut(id: String, outcome: ShannonPrivateReachOutOutcome) async throws {
        if let deliveryFailure { throw deliveryFailure }
        lock.withLock { outcomes.append(outcome) }
    }
}

@MainActor
final class FakeSpeaker: ShannonReachOutSpeaking {
    var outcome = ShannonReachOutSpeechOutcome.spoken
    /// Runs while "speaking", before the outcome is returned: the place to change the route under it.
    var whileSpeaking: (@MainActor () -> Void)?
    private(set) var spoken: [String] = []
    private(set) var askedPrivate: [Bool] = []
    private(set) var stops = 0

    func speak(_ text: String, stillPrivate: @escaping @MainActor () -> Bool) async -> ShannonReachOutSpeechOutcome {
        askedPrivate.append(stillPrivate())
        guard askedPrivate.last == true else { return .notStarted }
        spoken.append(text)
        whileSpeaking?()
        return stillPrivate() ? outcome : .cutShort
    }

    func stop() { stops += 1 }
}

@MainActor
final class FakeListener: ShannonReachOutListening {
    private(set) var windows: [Int] = []
    private(set) var threads: [String] = []

    func listen(for seconds: Int, after message: ShannonPrivateReachOutMessageDTO) async {
        windows.append(seconds)
        threads.append(message.threadId)
    }
}
