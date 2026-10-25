import Foundation
import Observation

/// What the settings row says about telling Shannon that only the owner can hear.
public enum ShannonPrivateListeningStatus: Equatable, Sendable {
    /// The sound does not come out of registered earphones or wired headphones; nothing is sent.
    case notListening
    /// Someone else may be listening (「友人も一緒」); nothing is sent however the sound comes out.
    case othersPresent
    /// This device is not paired with Shannon; only a paired device reports.
    case notPaired
    /// Private, and not yet told.
    case waiting
    case reported
    /// The server has no such route yet (404).
    case unsupported
    /// The server refuses reports: switched off there, or this device is not the owner's.
    case refused
    case failed
}

/// Tells Shannon's server whether only the owner can hear this app now (owner decision 2026-10-02).
///
/// "Only he can hear" is decided here, on the device: every current output is wired headphones or
/// earphones he registered, and nobody else is known to be present. While that holds the app reports
/// it every few seconds; the report lapses on the server by itself, and the app says "no longer" as
/// soon as the route changes, someone joins, or it stops. Nothing but a kind, a yes or no and a
/// timestamp is sent.
@MainActor
@Observable
public final class ShannonPrivateListeningModel {
    public private(set) var outputs: [ShannonAudioOutput] = []
    public private(set) var registered: [ShannonRegisteredEarphones] = []
    public private(set) var status: ShannonPrivateListeningStatus = .notListening

    /// Someone other than the owner may hear the device: 「友人も一緒」 or a companion he mentioned.
    public var othersPresent = false {
        didSet { if othersPresent != oldValue { evaluate() } }
    }

    /// Whether the app is in front. An iPhone app in the background is suspended unless it stands by, and
    /// cannot keep its report fresh, so it withdraws it when it leaves the foreground.
    public var isInForeground = true {
        didSet { if isInForeground != oldValue { evaluate() } }
    }

    /// iPhone: the app keeps an audio session alive in the background so that it can speak (`ShannonStandbyAudio`).
    public var isStandingBy = false {
        didSet { if isStandingBy != oldValue { evaluate() } }
    }

    /// The owner's switch: while only he can hear, Shannon may say a message she started on her own aloud.
    /// Off until he turns it on.
    public private(set) var speaksEnabled = false

    /// iPhone: the owner's switch for standing by in the background. Off until he turns it on.
    public private(set) var standbyEnabled = false

    /// iPhone: Low Power Mode is on. The app then does not stand by: the owner asked the phone to save battery.
    public var isLowPowerMode = false {
        didSet { if isLowPowerMode != oldValue { evaluate() } }
    }

    /// The server did not take the last report (not paired, no such route, refused). Until a report goes through,
    /// standing by would only use battery. Cleared by the next report that is accepted.
    public private(set) var serverRefuses = false

    /// The server has messages said through earphones, as far as its last answer to a report with `speaks` said.
    /// False for an older server and while that is switched off there: standing by would only use battery.
    public private(set) var serverDelivers = false

    /// Whether a wired output counts as headphones only the owner hears. The system cannot tell what is plugged
    /// into a headphone jack; someone who keeps speakers on it switches this off. On unless he does.
    public private(set) var wiredCountsAsPrivate = true

    /// iPhone: what the standby is doing, for the settings row. Set by the app.
    public var standbyState: ShannonStandbyState = .off

    /// Says a message she started on her own through the earphones, once the server offers it to this app.
    @ObservationIgnored public let reachOuts: ShannonPrivateReachOutCoordinator

    @ObservationIgnored private let client: (any ShannonPrivateListeningServing)?
    @ObservationIgnored private let monitor: any ShannonAudioRouteMonitoring
    @ObservationIgnored private let registry: ShannonEarphoneRegistry
    @ObservationIgnored private let kind: ShannonPrivateListeningKind
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let runsInBackground: Bool
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let ownerActivity: @MainActor () -> Date?
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async -> Void
    @ObservationIgnored private var toldListening = false
    @ObservationIgnored private var isReporting = false
    @ObservationIgnored private var needsAnotherReport = false
    @ObservationIgnored private var pollInterval = ShannonPrivateListeningModel.defaultPollInterval
    @ObservationIgnored private var lastAttemptAt: Date?
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var isPreview = false
    @ObservationIgnored private var runTask: Task<Void, Never>?
    /// Called whenever the route, a switch or who is present was looked at again (the iPhone's standby follows it).
    @ObservationIgnored public var stateEvaluated: (@MainActor () -> Void)?
    /// The platform's speaking and listening, kept alive for as long as the app runs.
    @ObservationIgnored var platformController: AnyObject?
    /// The Mac: follows 配信用の出力（OBS） (`ShannonPrivateListeningModel+Stream.swift`).
    @ObservationIgnored var streamObserver: NSObjectProtocol?

    public static let speaksDefaultsKey = "shannon.privateListening.speaks"
    public static let standbyDefaultsKey = "shannon.privateListening.standby"
    public static let wiredDefaultsKey = "shannon.privateListening.wiredCountsAsPrivate"
    /// While reports fail (no network) they are tried less often, up to this interval.
    public static let failingPollInterval: TimeInterval = 60
    public static let defaultPollInterval: TimeInterval = 15
    /// A server that refuses or does not know the route is asked again this seldom.
    public static let refusedPollInterval: TimeInterval = 10 * 60

    public init(
        client: (any ShannonPrivateListeningServing)?,
        monitor: any ShannonAudioRouteMonitoring,
        defaults: UserDefaults = .standard,
        kind: ShannonPrivateListeningKind = .current,
        runsInBackground: Bool = ShannonPrivateListeningKind.current == .mac,
        now: @escaping @Sendable () -> Date = { Date() },
        ownerActivity: @escaping @MainActor () -> Date? = { ShannonOwnerActivity.lastInput() },
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.client = client
        self.monitor = monitor
        self.registry = ShannonEarphoneRegistry(defaults: defaults)
        self.defaults = defaults
        self.kind = kind
        self.runsInBackground = runsInBackground
        self.now = now
        self.ownerActivity = ownerActivity
        self.sleep = sleep
        reachOuts = ShannonPrivateReachOutCoordinator(client: client, defaults: defaults)
        speaksEnabled = defaults.bool(forKey: Self.speaksDefaultsKey)
        standbyEnabled = defaults.bool(forKey: Self.standbyDefaultsKey)
        wiredCountsAsPrivate = defaults.object(forKey: Self.wiredDefaultsKey) as? Bool ?? true
        reachOuts.stillPrivate = { [weak self] in
            // Read from the system at that moment, not from what was last reported.
            guard let self, self.speaksEnabled else { return false }
            return self.refreshRoute()
        }
        registered = registry.load()
        outputs = monitor.currentOutputs()
        status = localStatus
    }

    /// A fixed state for design previews; it never reads a route or contacts a server.
    public static func designPreview(
        outputs: [ShannonAudioOutput], registered: [ShannonRegisteredEarphones], status: ShannonPrivateListeningStatus
    ) -> ShannonPrivateListeningModel {
        let model = ShannonPrivateListeningModel(client: nil, monitor: ShannonNoAudioRoute(),
            defaults: UserDefaults(suiteName: "shannon.private-listening.preview") ?? .standard)
        model.isPreview = true
        model.outputs = outputs
        model.registered = registered
        model.status = status
        return model
    }

    // MARK: What the device knows

    /// Every current output is wired headphones or registered earphones.
    public var isRoutePrivate: Bool {
        ShannonPrivateListeningJudge.isPrivate(route: outputs, registered: registered, wiredCountsAsPrivate: wiredCountsAsPrivate)
    }

    /// The Mac app runs whether or not it is in front; the iPhone app only in front, or while it stands by.
    public var isAppRunning: Bool { runsInBackground || isInForeground || isStandingBy }

    /// Only the owner can hear this app now, as far as the app can tell.
    public var isPrivatelyListening: Bool {
        isRoutePrivate && !othersPresent && isAppRunning
    }

    /// The app would say a message of hers aloud now. 「声: 出さない」 (`ShannonVoiceEar`) keeps her voice in, here too.
    public var speaksNow: Bool { speaksEnabled && ShannonVoiceEar.speaks(defaults) && isPrivatelyListening }

    /// A message could actually reach this app now: it would speak, and the server takes its reports and has the feature on.
    public var canBeOffered: Bool { speaksNow && serverDelivers && !serverRefuses }

    /// iPhone: the app should stand by now: both switches on, registered earphones connected, nobody else present,
    /// not saving battery, and a server that takes its reports and has something to say through them.
    public var wantsStandby: Bool {
        speaksEnabled && standbyEnabled && isRoutePrivate && !othersPresent && !isLowPowerMode && !serverRefuses && serverDelivers
    }

    /// The current output the owner could register: Bluetooth or USB, and not registered yet.
    public var registrableOutput: ShannonAudioOutput? {
        outputs.count == 1 ? outputs.first { output in
            output.canBeRegistered && !registered.contains { $0.id == output.id }
        } : nil
    }

    /// Reads the route again. Returns whether only the owner can hear now: asked right before anything is spoken.
    @discardableResult
    public func refreshRoute() -> Bool {
        guard !isPreview else { return isPrivatelyListening }
        let current = monitor.currentOutputs()
        if current != outputs {
            outputs = current
            stateEvaluated?()
        }
        return isPrivatelyListening
    }

    // MARK: Owner actions

    public func registerCurrentOutput() {
        guard !isPreview, let output = registrableOutput else { return }
        registered = registry.register(output, at: now())
        evaluate()
    }

    public func removeRegistration(id: String) {
        guard !isPreview else { return }
        registered = registry.remove(id: id)
        evaluate()
    }

    public func setSpeaksEnabled(_ enabled: Bool) {
        guard !isPreview, enabled != speaksEnabled else { return }
        speaksEnabled = enabled
        defaults.set(enabled, forKey: Self.speaksDefaultsKey)
        if !enabled { reachOuts.stopSpeaking() }
        evaluate()
    }

    public func setWiredCountsAsPrivate(_ counts: Bool) {
        guard !isPreview, counts != wiredCountsAsPrivate else { return }
        wiredCountsAsPrivate = counts
        defaults.set(counts, forKey: Self.wiredDefaultsKey)
        if !counts { reachOuts.stopSpeaking() }
        evaluate()
    }

    public func setStandbyEnabled(_ enabled: Bool) {
        guard !isPreview, enabled != standbyEnabled else { return }
        standbyEnabled = enabled
        defaults.set(enabled, forKey: Self.standbyDefaultsKey)
        evaluate()
    }

    // MARK: Reporting

    /// Starts following the route for as long as the app runs. Calling it again does nothing,
    /// so every window may ask.
    public func start() {
        guard !isPreview, runTask == nil else { return }
        runTask = Task { [weak self] in await self?.run() }
    }

    /// Follows the route and keeps the report fresh. Runs until cancelled.
    public func run() async {
        guard !isPreview else { return }
        let changes = monitor.changes()
        let observer = Task { [weak self] in
            for await _ in changes { self?.evaluate() }
        }
        defer { observer.cancel() }
        evaluate()
        await reachOuts.flushReports()
        while !Task.isCancelled {
            // The loop wakes at the short interval whatever the report interval is, so a longer one (after a refusal,
            // or while reports fail) ends as soon as a report goes through again.
            await sleep(min(pollInterval, Self.defaultPollInterval))
            if Task.isCancelled { break }
            refreshRoute()
            // What was done with a message is reported whether or not the earphones are still in.
            await reachOuts.flushReports()
            if let lastAttemptAt, now().timeIntervalSince(lastAttemptAt) < pollInterval - 1 { continue }
            await report()
        }
    }

    /// The route, the registry or who is present changed: tell the server at once.
    public func evaluate() {
        guard !isPreview else { return }
        outputs = monitor.currentOutputs()
        stateEvaluated?()
        if !isPrivatelyListening, !toldListening {
            status = localStatus
            return
        }
        Task { await report() }
    }

    /// Says "no longer" when the app is about to stop. The report also lapses by itself if this does not arrive.
    public func withdraw() async {
        guard !isPreview, toldListening, let client, let scopeKey = client.privateListeningScopeKey() else { return }
        toldListening = false
        _ = try? await client.reportPrivateListening(.init(scopeKey: scopeKey, kind: kind, listening: false))
    }

    public func report() async {
        guard !isPreview else { return }
        if isReporting {
            needsAnotherReport = true
            return
        }
        isReporting = true
        defer { isReporting = false }
        repeat {
            needsAnotherReport = false
            await sendCurrentState()
        } while needsAnotherReport
    }

    private func sendCurrentState() async {
        let listening = isPrivatelyListening
        guard listening || toldListening else {
            status = localStatus
            return
        }
        guard let client, let scopeKey = client.privateListeningScopeKey() else {
            toldListening = false
            status = listening ? .notPaired : localStatus
            if listening { refused() }
            return
        }
        let speaks = listening && speaksEnabled
        let report = ShannonPrivateListeningReportDTO(
            scopeKey: scopeKey, kind: kind, listening: listening, speaks: speaks,
            ownerActiveAt: listening ? ownerActivity() : nil
        )
        lastAttemptAt = now()
        do {
            let response = try await client.reportPrivateListening(report)
            toldListening = response.listening
            failures = 0
            // Only an answer to a report that said it speaks tells whether the server has anything to say through it.
            let delivers = speaks ? response.speaks == true : serverDelivers
            if serverRefuses || delivers != serverDelivers {
                serverRefuses = false
                serverDelivers = delivers
                stateEvaluated?()
            }
            pollInterval = response.pollAfterSeconds.map { max(5, TimeInterval($0)) } ?? Self.defaultPollInterval
            // The route may have changed while the request was in flight.
            if isPrivatelyListening != listening || speaksNow != speaks { needsAnotherReport = true }
            status = isPrivatelyListening ? (response.listening ? .reported : .waiting) : localStatus
            // Offered only to an app that said it speaks; whether it is still private is asked again before any sound.
            if let offer = response.reachOut, speaksNow {
                Task { [reachOuts] in await reachOuts.handle(offer) }
            }
            // A report of what was done with a message that did not arrive earlier goes out with every heartbeat.
            Task { [reachOuts] in await reachOuts.flushReports() }
        } catch let error as ShannonAPIError where error == .rejected(status: 404) {
            settleRefusal(.unsupported, listening: listening)
        } catch let error as ShannonAPIError where error == .rejected(status: 403) {
            settleRefusal(.refused, listening: listening)
        } catch let error as ShannonAPIError where error == .rejected(status: 401) {
            // The device's connection was revoked: as good as not paired.
            settleRefusal(.notPaired, listening: listening)
        } catch {
            // An unsent "no longer" needs no retry: the server drops a report that is not renewed.
            if !listening { toldListening = false }
            status = isPrivatelyListening ? .failed : localStatus
            // Without a network the report is tried less often: 15, 30, then 60 seconds.
            failures += 1
            pollInterval = min(Self.failingPollInterval, Self.defaultPollInterval * pow(2, Double(min(failures, 6) - 1)))
        }
    }

    private func settleRefusal(_ refusal: ShannonPrivateListeningStatus, listening: Bool) {
        toldListening = false
        pollInterval = Self.refusedPollInterval
        status = isPrivatelyListening ? refusal : localStatus
        refused()
    }

    private func refused() {
        guard !serverRefuses else { return }
        serverRefuses = true
        stateEvaluated?()
    }

    /// What the row says before the server is involved.
    private var localStatus: ShannonPrivateListeningStatus {
        if isRoutePrivate, othersPresent { return .othersPresent }
        return isPrivatelyListening ? .waiting : .notListening
    }
}

/// A route that is never there; used by design previews.
@MainActor
final class ShannonNoAudioRoute: ShannonAudioRouteMonitoring {
    func currentOutputs() -> [ShannonAudioOutput] { [] }
    func changes() -> AsyncStream<Void> { AsyncStream { $0.finish() } }
}
