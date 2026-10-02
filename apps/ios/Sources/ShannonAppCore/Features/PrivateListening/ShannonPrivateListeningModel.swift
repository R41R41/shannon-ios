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

    /// Whether the app runs now. An iPhone app in the background without a reason to run is suspended and
    /// cannot keep its report fresh, so it withdraws it when it leaves the foreground.
    public var isAppRunning = true {
        didSet { if isAppRunning != oldValue { evaluate() } }
    }

    @ObservationIgnored private let client: (any ShannonPrivateListeningServing)?
    @ObservationIgnored private let monitor: any ShannonAudioRouteMonitoring
    @ObservationIgnored private let registry: ShannonEarphoneRegistry
    @ObservationIgnored private let kind: ShannonPrivateListeningKind
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let ownerActivity: @MainActor () -> Date?
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async -> Void
    @ObservationIgnored private var toldListening = false
    @ObservationIgnored private var isReporting = false
    @ObservationIgnored private var needsAnotherReport = false
    @ObservationIgnored private var pollInterval = ShannonPrivateListeningModel.defaultPollInterval
    @ObservationIgnored private var isPreview = false
    @ObservationIgnored private var runTask: Task<Void, Never>?

    public static let defaultPollInterval: TimeInterval = 15
    /// A server that refuses or does not know the route is asked again this seldom.
    public static let refusedPollInterval: TimeInterval = 10 * 60

    public init(
        client: (any ShannonPrivateListeningServing)?,
        monitor: any ShannonAudioRouteMonitoring,
        registry: ShannonEarphoneRegistry = ShannonEarphoneRegistry(),
        kind: ShannonPrivateListeningKind = .current,
        now: @escaping @Sendable () -> Date = { Date() },
        ownerActivity: @escaping @MainActor () -> Date? = { ShannonOwnerActivity.lastInput() },
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.client = client
        self.monitor = monitor
        self.registry = registry
        self.kind = kind
        self.now = now
        self.ownerActivity = ownerActivity
        self.sleep = sleep
        registered = registry.load()
        outputs = monitor.currentOutputs()
        status = localStatus
    }

    /// A fixed state for design previews; it never reads a route or contacts a server.
    public static func designPreview(
        outputs: [ShannonAudioOutput], registered: [ShannonRegisteredEarphones], status: ShannonPrivateListeningStatus
    ) -> ShannonPrivateListeningModel {
        let model = ShannonPrivateListeningModel(client: nil, monitor: ShannonNoAudioRoute(),
            registry: ShannonEarphoneRegistry(defaults: UserDefaults(suiteName: "shannon.private-listening.preview") ?? .standard))
        model.isPreview = true
        model.outputs = outputs
        model.registered = registered
        model.status = status
        return model
    }

    // MARK: What the device knows

    /// Every current output is wired headphones or registered earphones.
    public var isRoutePrivate: Bool {
        ShannonPrivateListeningJudge.isPrivate(route: outputs, registered: registered)
    }

    /// Only the owner can hear this app now, as far as the app can tell.
    public var isPrivatelyListening: Bool {
        isRoutePrivate && !othersPresent && isAppRunning
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
        outputs = monitor.currentOutputs()
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
        while !Task.isCancelled {
            await sleep(pollInterval)
            if Task.isCancelled { break }
            refreshRoute()
            await report()
        }
    }

    /// The route, the registry or who is present changed: tell the server at once.
    public func evaluate() {
        guard !isPreview else { return }
        outputs = monitor.currentOutputs()
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
            return
        }
        let report = ShannonPrivateListeningReportDTO(
            scopeKey: scopeKey, kind: kind, listening: listening, ownerActiveAt: listening ? ownerActivity() : nil
        )
        do {
            let response = try await client.reportPrivateListening(report)
            toldListening = response.listening
            pollInterval = response.pollAfterSeconds.map { max(5, TimeInterval($0)) } ?? Self.defaultPollInterval
            // The route may have changed while the request was in flight.
            if isPrivatelyListening != listening { needsAnotherReport = true }
            status = isPrivatelyListening ? (response.listening ? .reported : .waiting) : localStatus
        } catch let error as ShannonAPIError where error == .rejected(status: 404) {
            settleRefusal(.unsupported, listening: listening)
        } catch let error as ShannonAPIError where error == .rejected(status: 403) {
            settleRefusal(.refused, listening: listening)
        } catch {
            // An unsent "no longer" needs no retry: the server drops a report that is not renewed.
            if !listening { toldListening = false }
            status = isPrivatelyListening ? .failed : localStatus
        }
    }

    private func settleRefusal(_ refusal: ShannonPrivateListeningStatus, listening: Bool) {
        toldListening = false
        pollInterval = Self.refusedPollInterval
        status = isPrivatelyListening ? refusal : localStatus
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
