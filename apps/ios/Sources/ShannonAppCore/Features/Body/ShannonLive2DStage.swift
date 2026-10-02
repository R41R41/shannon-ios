import Foundation
import Observation
import WebKit
#if canImport(UIKit)
import UIKit
typealias ShannonLive2DPlatformView = UIView
#elseif canImport(AppKit)
import AppKit
typealias ShannonLive2DPlatformView = NSView
#endif

/// The one Live2D figure of the app. The model costs seconds to load and a large texture,
/// so there is a single web view: the screen that appeared last shows it, and every other
/// place her figure stands shows the Waterlight Eye meanwhile.
@MainActor
@Observable
public final class ShannonLive2DStage {
    public static let shared = ShannonLive2DStage()

    public enum Status: Equatable, Sendable {
        case unloaded, loading, ready, failed
    }

    public private(set) var status: Status = .unloaded
    /// The host that shows the figure now.
    public private(set) var activeHost: UUID?
    /// True while the figure is a still picture because of Reduce Motion or Low Power Mode.
    public private(set) var isResting = false
    public private(set) var reduceMotion = false
    public private(set) var lowPower = false
    public private(set) var version: String?
    public private(set) var modelUpdatedAt: String?
    public private(set) var expressions: [String] = []
    public private(set) var gestures: [String] = []
    public internal(set) var framesPerSecond: Int?
    /// How far the page is with loading, 0–1, while `status` is `loading`.
    public private(set) var loadProgress = 0.0
    /// True when the page itself can calm its idle movement (`setIdle`); otherwise an idle figure is paused to rest.
    public private(set) var calmsInPage = false
    /// Seconds from starting the page to its `ready`, for the body screen's diagnostics.
    public private(set) var lastLoadSeconds: Double?

    /// Touches and reaction moments from the page. One listener: the touch coordinator.
    @ObservationIgnored public var onTouchMessage: (@MainActor (ShannonLive2DMessage) -> Void)?

    private struct Host {
        let id: UUID
        weak var container: ShannonLive2DPlatformView?
        let priority: ShannonLive2DHostPriority
        var layout: ShannonLive2DLayout
        var touchEnabled: Bool
    }

    @ObservationIgnored private var hosts: [Host] = []
    @ObservationIgnored private(set) var webView: WKWebView?
    @ObservationIgnored private var bridge: ShannonLive2DBridge?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var appActive = true
    @ObservationIgnored var sentPaused: Bool?
    @ObservationIgnored private var lastReloadAt: Date?
    @ObservationIgnored private(set) var loadStartedAt: Date?
    @ObservationIgnored var lastActivityAt = Date()
    @ObservationIgnored private var restTask: Task<Void, Never>?
    @ObservationIgnored private var releaseTask: Task<Void, Never>?
    @ObservationIgnored private var timeoutTask: Task<Void, Never>?
    @ObservationIgnored var mood: (valence: Double, arousal: Double, openness: Double)?
    @ObservationIgnored var presence: ShannonLive2DPresence?
    @ObservationIgnored var phase: ShannonLive2DPhase = .idle
    @ObservationIgnored var lastMouthLevel = 0.0
    @ObservationIgnored var frameStats = false
    @ObservationIgnored private var observing = false
    @ObservationIgnored private var failuresWithoutReady = 0
    @ObservationIgnored private var fingerDown = false
    @ObservationIgnored private var lastHeardAt = Date()

    private init() {}

    /// The bundled page, or nil in a build without it.
    public static let embedFolder: URL? = {
        guard let folder = Bundle.module.url(forResource: "Live2D", withExtension: nil)?.appendingPathComponent("embed", isDirectory: true),
              FileManager.default.fileExists(atPath: folder.appendingPathComponent("embed.html").path) else { return nil }
        return folder
    }()

    public static var isAvailable: Bool { embedFolder != nil }

    private var calm: Bool { reduceMotion || lowPower }

    // MARK: Hosts

    /// A screen that shows her figure came on. The one with the highest priority shows the web view.
    func attach(
        host id: UUID, container: ShannonLive2DPlatformView, priority: ShannonLive2DHostPriority,
        layout: ShannonLive2DLayout, touchEnabled: Bool
    ) {
        hosts.removeAll { $0.id == id || $0.container == nil }
        let index = ShannonLive2DStagePolicy.insertionIndex(for: priority, among: hosts.map(\.priority))
        hosts.insert(Host(id: id, container: container, priority: priority, layout: layout, touchEnabled: touchEnabled), at: index)
        releaseTask?.cancel()
        releaseTask = nil
        observeSystem()
        if status == .unloaded { load() }
        mount()
        noteActivity()
    }

    func update(host id: UUID, layout: ShannonLive2DLayout, touchEnabled: Bool) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        let changed = hosts[index].layout != layout || hosts[index].touchEnabled != touchEnabled
        hosts[index].layout = layout
        hosts[index].touchEnabled = touchEnabled
        guard changed, activeHost == id else { return }
        applyHost()
        noteActivity()
    }

    /// The host's size changed: the page lays out against its own window height.
    func hostDidLayout(_ id: UUID) {
        guard activeHost == id else { return }
        if let container = hosts.last?.container, let webView, webView.frame != container.bounds {
            webView.frame = container.bounds
        }
        applyHost()
    }

    func detach(host id: UUID) {
        guard hosts.contains(where: { $0.id == id }) else { return }
        hosts.removeAll { $0.id == id || $0.container == nil }
        mount()
        guard hosts.isEmpty else { return }
        releaseTask?.cancel()
        releaseTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ShannonLive2DStagePolicy.releaseAfterSeconds))
            guard !Task.isCancelled, let self, self.hosts.isEmpty else { return }
            self.release()
        }
    }

    private func mount() {
        hosts.removeAll { $0.container == nil }
        guard let host = hosts.last, let container = host.container else {
            activeHost = nil
            webView?.removeFromSuperview()
            refreshPaused()
            return
        }
        activeHost = host.id
        if let webView, webView.superview !== container {
            webView.removeFromSuperview()
            webView.frame = container.bounds
#if canImport(UIKit)
            webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
#else
            webView.autoresizingMask = [.width, .height]
#endif
            container.addSubview(webView)
        }
        applyHost()
        refreshPaused()
    }

    private func applyHost() {
        guard let host = hosts.last else { return }
        send(.setLayout(host.layout))
        send(.setTouchEnabled(host.touchEnabled))
    }

    // MARK: Driving (the calls into the page are in `ShannonLive2DStage+Driving.swift`)

    /// The owner asked for another try after a failure.
    public func retry() {
        lastReloadAt = nil
        failuresWithoutReady = 0
        release()
        guard !hosts.isEmpty else { return }
        load()
        mount()
    }

    /// A finger is on her, or has just lifted. A held hand or a long pet is not idleness.
    func setFingerDown(_ down: Bool) {
        fingerDown = down
        noteActivity()
    }

    /// Something happened that a resting figure should move for: a touch, a new face, a phase.
    func noteActivity() {
        lastActivityAt = Date()
        if isResting { isResting = false }
        refreshPaused()
        scheduleRest()
    }

    func send(_ command: ShannonLive2DCommand) {
        guard status == .ready, let webView else { return }
        webView.evaluateJavaScript(command.javaScript, completionHandler: nil)
    }

    // MARK: Pausing

    private func refreshPaused() {
        let paused = ShannonLive2DStagePolicy.paused(hasHost: activeHost != nil, appActive: appActive, resting: isResting)
        guard status == .ready, sentPaused != paused else { return }
        sentPaused = paused
        if paused, lastMouthLevel > 0 {
            lastMouthLevel = 0
            send(.setMouthLevel(0))
        }
        send(.setPaused(paused))
    }

    /// Reduce Motion: no gestures of her own and no sway, while breathing, blinking, faces and touch go on.
    /// Low Power Mode: half the frames. Sent again whenever either setting changes.
    private func applyCalm() {
        guard calmsInPage else { return }
        send(.setIdle(gestures: !reduceMotion, sway: reduceMotion ? 0 : 1))
        send(.setFrameRate(ShannonLive2DStagePolicy.frameRate(lowPower: lowPower)))
    }

    /// The page's version does not say which calls it has, so it is asked.
    private func detectCalm(generation asked: Int) {
        webView?.evaluateJavaScript("typeof window.shannonBody.setIdle==='function'&&typeof window.shannonBody.setFrameRate==='function'") { [weak self] result, _ in
            let supported = (result as? Bool) == true
            Task { @MainActor in
                guard let self, self.generation == asked else { return }
                self.calmsInPage = supported
                if supported, self.isResting { self.isResting = false }
                self.applyCalm()
                self.refreshPaused()
                self.scheduleRest()
            }
        }
    }

    private func scheduleRest() {
        restTask?.cancel()
        restTask = nil
        // A page that calms itself is never paused to rest.
        guard calm, !calmsInPage, status == .ready, activeHost != nil else { return }
        restTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                guard self.calm, self.status == .ready, self.activeHost != nil else { return }
                if ShannonLive2DStagePolicy.rests(
                    calm: true, phase: self.phase, idleSeconds: Date().timeIntervalSince(self.lastActivityAt), fingerDown: self.fingerDown) {
                    self.isResting = true
                    self.refreshPaused()
                    return
                }
            }
        }
    }

    // MARK: Loading

    private func load() {
        guard let folder = Self.embedFolder else {
            status = .failed
            return
        }
        generation += 1
        let generation = generation
        status = .loading
        loadProgress = 0
        lastHeardAt = Date()
        sentPaused = nil
        lastMouthLevel = 0
        loadStartedAt = Date()

        let bridge = ShannonLive2DBridge(stage: self, generation: generation, folder: folder)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(bridge, name: ShannonLive2DBridge.handlerName)
#if canImport(UIKit)
        configuration.allowsInlineMediaPlayback = false
#endif
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = bridge
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
#if canImport(UIKit)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        // The figure is one element for VoiceOver: the SwiftUI host carries her label.
        webView.isAccessibilityElement = false
        webView.accessibilityElementsHidden = true
#else
        webView.setValue(false, forKey: "drawsBackground")
#endif
#if DEBUG
        if #available(iOS 16.4, macOS 13.3, *) { webView.isInspectable = true }
#endif
        self.bridge = bridge
        self.webView = webView

        // The page makes no request by itself; this makes sure of it for anything it might load later.
        Task { [weak self, weak webView] in
            let rules = try? await ShannonLive2DBridge.offlineRuleList()
            guard let self, let webView, self.generation == generation, self.webView === webView else { return }
            // Fail closed: without the block list the page is not loaded at all.
            guard let rules else {
                NSLog("[ShannonBody] the offline content rules did not compile; the Live2D page was not loaded")
                self.refuse()
                return
            }
            webView.configuration.userContentController.add(rules)
            webView.loadFileURL(folder.appendingPathComponent("embed.html"), allowingReadAccessTo: folder)
        }

        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            // Only time in the foreground counts: a page in a backgrounded app is suspended, not broken.
            var waited = 0.0
            var silent = 0.0
            var heardAt = Date.distantPast
            while !ShannonLive2DStagePolicy.loadTimedOut(waited: waited, silent: silent) {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, self.generation == generation, self.status == .loading else { return }
                // A page that keeps reporting its progress is alive, however long the model takes.
                if self.lastHeardAt != heardAt {
                    heardAt = self.lastHeardAt
                    silent = 0
                }
                if self.appActive {
                    waited += 1
                    silent += 1
                }
            }
            guard !Task.isCancelled, let self, self.generation == generation, self.status == .loading else { return }
            self.recover(generation: generation)
        }
    }

    /// Lets the web view and its model go. The next host loads it again.
    private func release() {
        generation += 1
        timeoutTask?.cancel()
        restTask?.cancel()
        releaseTask?.cancel()
        timeoutTask = nil
        restTask = nil
        releaseTask = nil
        if let webView {
            webView.stopLoading()
            webView.navigationDelegate = nil
            webView.configuration.userContentController.removeScriptMessageHandler(forName: ShannonLive2DBridge.handlerName)
            webView.configuration.userContentController.removeAllUserScripts()
            webView.removeFromSuperview()
        }
        webView = nil
        bridge = nil
        calmsInPage = false
        loadProgress = 0
        sentPaused = nil
        isResting = false
        framesPerSecond = nil
        lastMouthLevel = 0
        status = .unloaded
    }

    /// Something that a reload cannot mend: shown as failed until the owner asks again.
    private func refuse() {
        release()
        status = .failed
    }

    /// The page failed, lost its drawing context, or its process ended: one reload, then an honest failure.
    func recover(generation failed: Int) {
        guard failed == generation else { return }
        let now = Date()
        // A page that was drawing and broke is given another start; one that never became ready is not reloaded for ever.
        failuresWithoutReady = status == .ready ? 0 : failuresWithoutReady + 1
        let mayReload = ShannonLive2DStagePolicy.mayReload(lastReloadAt: lastReloadAt, now: now, failuresWithoutReady: failuresWithoutReady)
        release()
        guard mayReload, !hosts.isEmpty else {
            status = hosts.isEmpty ? .unloaded : .failed
            return
        }
        lastReloadAt = now
        load()
        mount()
    }

    func receive(_ message: ShannonLive2DMessage, generation received: Int) {
        guard received == generation else { return }
#if DEBUG
        probe(message)
#endif
        switch message {
        case let .ready(version, modelUpdatedAt, expressions, gestures):
            timeoutTask?.cancel()
            timeoutTask = nil
            self.version = version
            self.modelUpdatedAt = modelUpdatedAt
            self.expressions = expressions
            self.gestures = gestures
            lastLoadSeconds = loadStartedAt.map { Date().timeIntervalSince($0) }
            failuresWithoutReady = 0
            loadProgress = 1
            status = .ready
            detectCalm(generation: received)
            if let mood { send(.setMood(valence: mood.valence, arousal: mood.arousal, openness: mood.openness)) }
            if let presence { send(.setPresence(presence)) }
            send(.setPhase(phase))
            if frameStats { send(.setFrameStats(true)) }
            applyHost()
            refreshPaused()
            lastActivityAt = Date()
            scheduleRest()
        case let .loading(progress):
            lastHeardAt = Date()
            if status == .loading { loadProgress = max(loadProgress, progress) }
        case .error:
            // Also `code: contextLost`: the page tried three times to make its drawing surface again and could not.
            recover(generation: received)
        case .contextLost, .contextRestored:
            // The page mends this itself and keeps the face, the mood and the layout; a reload would only lose them.
            lastActivityAt = Date()
        case let .frameStats(fps):
            framesPerSecond = fps
        case .touch, .askReaction, .tap:
            lastActivityAt = Date()
            onTouchMessage?(message)
        }
    }

    // MARK: The system

    private func observeSystem() {
        guard !observing else { return }
        observing = true
        let system = ShannonLive2DSystem.current
        reduceMotion = system.reduceMotion
        lowPower = system.lowPower
        appActive = system.appActive
        ShannonLive2DSystem.observe { [weak self] change in
            switch change {
            case let .reduceMotion(value): self?.calmChanged(reduceMotion: value)
            case let .lowPower(value): self?.calmChanged(lowPower: value)
            case let .active(value): self?.activeChanged(value)
            case .memoryWarning: self?.memoryWarning()
            }
        }
    }

    private func calmChanged(reduceMotion: Bool? = nil, lowPower: Bool? = nil) {
        if let reduceMotion { self.reduceMotion = reduceMotion }
        if let lowPower { self.lowPower = lowPower }
        applyCalm()
        noteActivity()
    }

    private func activeChanged(_ active: Bool) {
        appActive = active
        refreshPaused()
        guard active else { return }
        noteActivity()
    }

    /// With no screen showing her, the model is let go at once; a visible figure is left to the system,
    /// which ends the page's process if it must (and the page then reloads once).
    private func memoryWarning() {
        guard hosts.isEmpty, status != .unloaded else { return }
        release()
    }
}
