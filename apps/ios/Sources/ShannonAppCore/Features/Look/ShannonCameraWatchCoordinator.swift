import Foundation
import Observation

/// The facts and devices watching depends on, so that the rules can be tested without a camera or a system.
public struct ShannonCameraWatchEnvironment: Sendable {
    public var system: @MainActor @Sendable () -> ShannonCameraWatchSystemFacts
    public var settingOn: @MainActor @Sendable () -> Bool
    public var permission: @MainActor @Sendable () -> ShannonMediaPermission
    public var camera: any ShannonCameraWatchCapturing
    /// Starts following the system: `changed` on any change of a condition, `reopened` when the app comes back.
    public var startMonitoring: @MainActor @Sendable (
        _ changed: @escaping @MainActor () -> Void, _ reopened: @escaping @MainActor () -> Void
    ) -> Void
    public var stopMonitoring: @MainActor @Sendable () -> Void
    public var now: @Sendable () -> Date = { Date() }
    /// Whether the sign registered under this id can be seen now (`ShannonCameraWatchSignAnchors`): a presentation over it hides it.
    public var signVisible: @MainActor @Sendable (UUID) -> Bool = { _ in true }
    /// How often, while a sign is registered, the coordinator looks again whether one is visible (presentations post no notice).
    public var signCheckInterval: Duration = .milliseconds(250)

    public init(
        system: @escaping @MainActor @Sendable () -> ShannonCameraWatchSystemFacts,
        settingOn: @escaping @MainActor @Sendable () -> Bool,
        permission: @escaping @MainActor @Sendable () -> ShannonMediaPermission,
        camera: any ShannonCameraWatchCapturing,
        startMonitoring: @escaping @MainActor @Sendable (
            _ changed: @escaping @MainActor () -> Void, _ reopened: @escaping @MainActor () -> Void
        ) -> Void,
        stopMonitoring: @escaping @MainActor @Sendable () -> Void
    ) {
        self.system = system
        self.settingOn = settingOn
        self.permission = permission
        self.camera = camera
        self.startMonitoring = startMonitoring
        self.stopMonitoring = stopMonitoring
    }
}

/// Shannon's camera while the app is open (Syzygy ADR-0011 §4.4, stage 1): opens the camera only while every condition
/// holds, judges frames on the device, sends a small frame only when something changed, shows her reaction at once, and
/// closes the camera the moment any condition fails. The 「見ています」 sign is shown wherever the look's sign is.
/// It keeps no picture: a frame lives from the camera to its one request.
@MainActor
@Observable
public final class ShannonCameraWatchCoordinator {
    /// A reaction the worker chose, shown on her figure and face for a moment.
    public struct Reaction: Equatable, Identifiable, Sendable {
        public let id: UUID
        public let expression: ShannonExpressionDTO
    }

    public static let reactionSeconds = 3.0
    public static let lookedCueSeconds = 1.5
    public static let noticeSeconds = 6.0

    /// The camera is open and watching: 「見ています」.
    public private(set) var isWatching = false
    /// The owner pressed 「止める」: the sign offers 「再開」 until the app is opened again.
    public private(set) var stoppedByOwner = false
    /// Why watching just stopped, for a few seconds. nil when it stopped for a reason that needs no word.
    public private(set) var notice: String?
    /// Set for a moment when a frame was sent: the sign says 「いま見ました」.
    public private(set) var lookedCue: UUID?
    public private(set) var reaction: Reaction?
    /// Whether the sign has anything to show.
    public var showsSign: Bool { isWatching || stoppedByOwner || notice != nil }

    @ObservationIgnored let client: (any ShannonVisionServing)?
    @ObservationIgnored private let environment: ShannonCameraWatchEnvironment
    @ObservationIgnored var maySend: @MainActor () -> Bool = { true }
    @ObservationIgnored private var signs: Set<UUID> = []
    /// Whether a registered sign was visible at the last look (`signVisible`), and the task that looks again.
    @ObservationIgnored private var signShown = false
    @ObservationIgnored private var signCheck: Task<Void, Never>?
    @ObservationIgnored private(set) var othersPresent = false
    @ObservationIgnored private(set) var othersSeen = false
    @ObservationIgnored private(set) var peopleUncounted = false
    @ObservationIgnored private var lookInProgress = false
    @ObservationIgnored private var cameraBusy = false
    @ObservationIgnored private var lastSettingOn: Bool?
    @ObservationIgnored private(set) var server = ShannonCameraWatchServerVerdict.unknown
    @ObservationIgnored private(set) var limits = ShannonCameraWatchLimits()
    @ObservationIgnored private(set) var sessionId: String?
    @ObservationIgnored private(set) var generation = 0
    @ObservationIgnored private var askingServer = false
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var sendTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    public init(client: (any ShannonVisionServing)?, environment: ShannonCameraWatchEnvironment) {
        self.client = client
        self.environment = environment
    }

    /// The conditions as they are now.
    func conditions() -> ShannonCameraWatchConditions {
        let system = environment.system()
        var facts = ShannonCameraWatchConditions()
        facts.canSend = client != nil && maySend()
        facts.hasSign = anySignVisible()
        facts.appInFront = system.appInFront
        facts.unlocked = system.unlocked
        facts.lowPowerMode = system.lowPowerMode
        facts.thermalHeavy = system.thermalHeavy
        facts.settingOn = environment.settingOn()
        facts.permission = environment.permission()
        facts.stoppedByOwner = stoppedByOwner
        facts.othersPresent = othersPresent
        facts.othersSeen = othersSeen
        facts.peopleUncounted = peopleUncounted
        facts.lookInProgress = lookInProgress
        facts.cameraBusy = cameraBusy
        facts.server = server
        return facts
    }

    // MARK: Where the sign is shown

    /// A surface that shows the sign appeared. The first one starts following the system.
    public func register(sign id: UUID) {
        let first = signs.isEmpty
        signs.insert(id)
        if first {
            environment.startMonitoring({ [weak self] in self?.reevaluate() }, { [weak self] in self?.reopened() })
            followSignVisibility()
        }
        reevaluate()
    }

    /// Whether any registered sign can be seen now. A sheet or cover over every surface with a sign closes the camera, whichever
    /// sheet it is (one added later included); a presentation that shows the sign itself has its own anchor.
    private func anySignVisible() -> Bool {
        signs.contains { environment.signVisible($0) }
    }

    /// Looks again every `signCheckInterval` (a quarter second) while a sign is registered, and reevaluates when visibility changed.
    private func followSignVisibility() {
        signCheck?.cancel()
        signShown = anySignVisible()
        let interval = environment.signCheckInterval
        signCheck = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard let self, !Task.isCancelled else { return }
                let shown = self.anySignVisible()
                if shown != self.signShown {
                    self.signShown = shown
                    self.reevaluate()
                }
            }
        }
    }

    public func unregister(sign id: UUID) {
        signs.remove(id)
        if signs.isEmpty {
            environment.stopMonitoring()
            signCheck?.cancel()
            signCheck = nil
        }
        reevaluate()
    }

    // MARK: What changes the conditions

    /// Someone else may be listening on this device (「友人も一緒」, a companion just mentioned, the stream output).
    public func setOthersPresent(_ value: Bool) {
        guard othersPresent != value else { return }
        othersPresent = value
        reevaluate()
    }

    /// 「止める」 on the sign: the camera closes and stays closed until the app is opened again or the owner resumes.
    public func stopByOwner() {
        stoppedByOwner = true
        reevaluate()
    }

    /// 「再開」 on the sign.
    public func resumeByOwner() {
        clearStops()
        reevaluate()
    }

    /// The app came back after being put away: what stopped watching for this opening is forgotten.
    func reopened() {
        clearStops()
        reevaluate()
    }

    private func clearStops() {
        stoppedByOwner = false
        othersSeen = false
        peopleUncounted = false
        cameraBusy = false
        server = .unknown
        sessionId = nil
        dismissNotice()
    }

    /// A one-shot look (or the call's system camera) needs the camera: watching closes it first and opens it again afterwards.
    public func yieldCamera(_ held: Bool) async {
        lookInProgress = held
        // The other user may have taken the camera from under watching: that is over once it gives the camera back.
        if !held { cameraBusy = false }
        reevaluate()
        if held { await environment.camera.waitUntilIdle() }
    }

    /// Applies the rule to the conditions now: opens or closes the camera, or asks the server first.
    public func reevaluate() {
        let setting = environment.settingOn()
        // Switching 「アプリを開いている間は見る」 back on is the owner's say-so to watch again.
        if setting, lastSettingOn == false { clearStops() }
        lastSettingOn = setting
        switch ShannonCameraWatchPolicy.verdict(conditions()) {
        case .watch:
            openCamera()
            keepRefreshing()
        case .askServer:
            closeCamera(because: nil)
            askServer()
        case let .hold(hold):
            apply(hold: hold)
        }
    }

    private func apply(hold: ShannonCameraWatchHold) {
        closeCamera(because: hold)
        switch hold {
        case .server, .serverUnreachable, .cameraBusy, .lookInProgress:
            // The server's word, the camera and a look change by themselves: read again every 30 seconds.
            keepRefreshing()
        default:
            // A condition of the device: the server is asked again before the camera opens next.
            stopRefreshing()
            if server != .unsupported { server = .unknown }
            if hold == .background || hold == .locked || hold == .switchedOff { sessionId = nil }
        }
    }

    // MARK: The camera

    private func openCamera() {
        guard !isWatching else { return }
        dismissNotice()
        if sessionId == nil {
            sessionId = "watch-\(UUID().uuidString.lowercased())"
            generation = 0
        }
        generation += 1
        let opened = generation
        isWatching = true
        environment.camera.start(limits: limits) { [weak self] event in
            Task { @MainActor [weak self] in self?.handle(event, generation: opened) }
        }
    }

    /// Closes the camera at once and drops the frame in flight. `hold` names why, for the sign.
    private func closeCamera(because hold: ShannonCameraWatchHold?) {
        guard isWatching else { return }
        isWatching = false
        environment.camera.stop()
        sendTask?.cancel()
        sendTask = nil
        lookedCue = nil
        if let hold, let words = ShannonCameraWatchCopy.stopped(hold) { show(notice: words) }
    }

    private func handle(_ event: ShannonCameraWatchEvent, generation opened: Int) {
        guard isWatching, opened == generation else {
            // A frame from a camera that has since closed is dropped unsent.
            if case .shot = event { environment.camera.settle(notBefore: nil) }
            return
        }
        switch event {
        case let .shot(shot):
            send(shot, generation: opened)
        case let .othersSeen(count):
            othersSeen = true
            sessionId = nil
            reevaluate()
            let client = client
            let at = environment.now()
            Task { try? await client?.reportVisionPresence(personCount: count, at: at) }
        case .peopleUncounted:
            // Unsure is not alone: closed until the app is opened again, like two people seen (nothing is reported).
            peopleUncounted = true
            sessionId = nil
            reevaluate()
        case .interrupted:
            cameraBusy = true
            reevaluate()
        }
    }

    // MARK: Sending a frame

    private func send(_ shot: ShannonCameraWatchShot, generation opened: Int) {
        // The conditions are read once more at the moment of sending: a frame taken as the app left is not sent.
        guard let client, let sessionId, ShannonCameraWatchPolicy.verdict(conditions()) == .watch else {
            environment.camera.settle(notBefore: nil)
            return
        }
        let frame = Self.frame(shot, sessionId: sessionId, generation: opened, deviceId: client.visionDeviceId, ttlMs: limits.ttlMs)
        flashLooked()
        sendTask = Task { [weak self] in
            let result = await client.sendVisionFrame(frame, jpeg: shot.frame.jpeg)
            guard !Task.isCancelled else { return }
            self?.received(result, generation: opened)
        }
    }

    static func frame(_ shot: ShannonCameraWatchShot, sessionId: String, generation: Int, deviceId: String?, ttlMs: Int) -> ShannonVisionFrame {
        ShannonVisionFrame(
            frameId: UUID().uuidString.lowercased(),
            capturedAt: ShannonVisionWire.timestamp(shot.capturedAt),
            source: ShannonVisionSource(kind: .appCamera, bodyId: nil, deviceId: deviceId.flatMap(validId)),
            sessionId: sessionId, generation: generation, privacy: .ownerPrivate, audienceAtCapture: .ownerAlone, ttlMs: ttlMs,
            encoding: ShannonVisionEncoding(width: shot.frame.width, height: shot.frame.height, format: .jpeg, byteLength: shot.frame.jpeg.count),
            gate: ShannonVisionGate(
                reason: shot.reason, difference: shot.difference.map { ($0 * 1_000).rounded() / 1_000 }, personCount: shot.personCount)
        )
    }

    /// An id the contract accepts (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$`), or nil.
    static func validId(_ value: String) -> String? {
        value.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$"#, options: .regularExpression) != nil ? value : nil
    }

    func received(_ result: ShannonVisionFrameResult, generation opened: Int) {
        sendTask = nil
        switch result {
        case let .reply(reply):
            environment.camera.settle(notBefore: ShannonVisionWire.date(reply.nextFrameNotBefore))
            if reply.watch == .stop || reply.degrade >= ShannonCameraWatchPolicy.stopDegrade {
                server = .refused(reply.stopReason ?? .degraded)
                sessionId = nil
                reevaluate()
            } else if isWatching, opened == generation, let shown = reply.reactionToShow {
                show(reaction: shown.expression)
            }
        case let .notNow(until):
            environment.camera.settle(notBefore: until)
        case .workerDown:
            // ADR-0011 §8.1: 「視覚ワーカーが落ちた … カメラの見続けは止める」.
            server = .unreachable
            sessionId = nil
            reevaluate()
        case .rejected(status: 409):
            // The server has moved past this session (it stopped it): the next frame starts a new one.
            environment.camera.settle(notBefore: nil)
            sessionId = "watch-\(UUID().uuidString.lowercased())"
        case .rejected(status: 401), .rejected(status: 403), .rejected(status: 404):
            server = .unsupported
            reevaluate()
        case .rejected:
            environment.camera.settle(notBefore: nil)
        }
    }

    // MARK: The server's word

    private func askServer() {
        guard !askingServer else { return }
        askingServer = true
        Task { [weak self] in
            await self?.readStatus()
            self?.askingServer = false
            self?.reevaluate()
        }
    }

    func readStatus() async {
        guard let client else { return }
        do {
            let status = try await client.visionStatus()
            server = ShannonCameraWatchPolicy.serverVerdict(status)
            limits = ShannonCameraWatchLimits().tightened(by: status.limits)
        } catch ShannonAPIError.rejected(let status) where [401, 403, 404].contains(status) {
            server = .unsupported
        } catch is DecodingError {
            server = .unsupported
        } catch {
            server = .unreachable
        }
    }

    /// Reads the server's word again every 30 seconds while the device would watch (or waits only for the server).
    private func keepRefreshing() {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(ShannonCameraWatchPolicy.statusRefreshSeconds))
                guard !Task.isCancelled, let self else { return }
                // A camera that was busy, and a permission changed in the system's settings, are tried again here too.
                self.cameraBusy = false
                await self.readStatus()
                guard !Task.isCancelled else { return }
                self.reevaluate()
            }
        }
    }

    private func stopRefreshing() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    // MARK: What the sign shows

    private func show(reaction expression: ShannonExpressionDTO) {
        let shown = Reaction(id: UUID(), expression: expression)
        reaction = shown
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.reactionSeconds))
            if self?.reaction?.id == shown.id { self?.reaction = nil }
        }
    }

    private func flashLooked() {
        let cue = UUID()
        lookedCue = cue
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.lookedCueSeconds))
            if self?.lookedCue == cue { self?.lookedCue = nil }
        }
    }

    private func show(notice words: String) {
        notice = words
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.noticeSeconds))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    private func dismissNotice() {
        noticeTask?.cancel()
        noticeTask = nil
        notice = nil
    }
}
