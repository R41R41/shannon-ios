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
        client: FakeListeningClient?, monitor: FakeRouteMonitor, activity: Date? = nil
    ) -> ShannonPrivateListeningModel {
        ShannonPrivateListeningModel(
            client: client, monitor: monitor, registry: ShannonEarphoneRegistry(defaults: defaults), kind: .mac,
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

    func testAnAppThatStopsRunningWithdrawsItsReport() async {
        let client = FakeListeningClient()
        let model = makeModel(client: client, monitor: FakeRouteMonitor(outputs: [wired]))
        await model.report()
        model.isAppRunning = false
        await model.report()
        XCTAssertEqual(client.reports.map(\.listening).last, false)
        XCTAssertEqual(model.status, .notListening)
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
        XCTAssertEqual(Set(json.keys), ["scopeKey", "kind", "listening", "ownerActiveAt"])
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

    func privateListeningScopeKey() -> String? { scopeKey }

    func reportPrivateListening(_ report: ShannonPrivateListeningReportDTO) async throws -> ShannonPrivateListeningResponseDTO {
        lock.withLock { stored.append(report) }
        if let failure { throw failure }
        return ShannonPrivateListeningResponseDTO(listening: report.listening, since: nil, expiresAt: nil, pollAfterSeconds: 15)
    }
}
