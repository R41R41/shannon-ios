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

/// The rules of the stage that need no web view, so they can be tested.
enum ShannonLive2DStagePolicy {
    /// The page stops drawing while nobody can see it, while the app is not active, and while it rests.
    static func paused(hasHost: Bool, appActive: Bool, resting: Bool) -> Bool {
        !hasHost || !appActive || resting
    }

    /// With Reduce Motion or Low Power Mode on, an idle figure becomes a still picture after this long.
    static let restAfterSeconds: TimeInterval = 5
    static func rests(calm: Bool, phase: ShannonLive2DPhase, idleSeconds: TimeInterval) -> Bool {
        calm && phase == .idle && idleSeconds >= restAfterSeconds
    }

    /// One automatic reload per minute; a second failure inside it is shown as failed.
    static let reloadSpacingSeconds: TimeInterval = 60
    static func mayReload(lastReloadAt: Date?, now: Date) -> Bool {
        guard let lastReloadAt else { return true }
        return now.timeIntervalSince(lastReloadAt) >= reloadSpacingSeconds
    }

    /// The page is given this long to say `ready`.
    static let loadTimeoutSeconds: TimeInterval = 90
    /// With no screen showing her, the model (about 85 MB of GPU memory) is let go after this long.
    static let releaseAfterSeconds: TimeInterval = 90

    /// A mouth level worth a call: any change of note, and always the return to zero.
    static func sendsMouthLevel(_ level: Double, last: Double) -> Bool {
        level <= 0 ? last > 0 : abs(level - last) >= 0.03
    }
}

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
    public private(set) var framesPerSecond: Int?
    /// Seconds from starting the page to its `ready`, for the body screen's diagnostics.
    public private(set) var lastLoadSeconds: Double?

    /// Touches and reaction moments from the page. One listener: the touch coordinator.
    @ObservationIgnored public var onTouchMessage: (@MainActor (ShannonLive2DMessage) -> Void)?

    private struct Host {
        let id: UUID
        weak var container: ShannonLive2DPlatformView?
        var layout: ShannonLive2DLayout
        var touchEnabled: Bool
    }

    @ObservationIgnored private var hosts: [Host] = []
    @ObservationIgnored private var webView: WKWebView?
    @ObservationIgnored private var bridge: ShannonLive2DBridge?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var appActive = true
    @ObservationIgnored private var sentPaused: Bool?
    @ObservationIgnored private var lastReloadAt: Date?
    @ObservationIgnored private var loadStartedAt: Date?
    @ObservationIgnored private var lastActivityAt = Date()
    @ObservationIgnored private var restTask: Task<Void, Never>?
    @ObservationIgnored private var releaseTask: Task<Void, Never>?
    @ObservationIgnored private var timeoutTask: Task<Void, Never>?
    @ObservationIgnored private var mood: (valence: Double, arousal: Double, openness: Double)?
    @ObservationIgnored private var presence: ShannonLive2DPresence?
    @ObservationIgnored private var phase: ShannonLive2DPhase = .idle
    @ObservationIgnored private var lastMouthLevel = 0.0
    @ObservationIgnored private var frameStats = false
    @ObservationIgnored private var observing = false

    private init() {}

    /// The bundled page, or nil in a build without it.
    public static var embedFolder: URL? {
        guard let folder = Bundle.module.url(forResource: "Live2D", withExtension: nil)?.appendingPathComponent("embed", isDirectory: true),
              FileManager.default.fileExists(atPath: folder.appendingPathComponent("embed.html").path) else { return nil }
        return folder
    }

    public static var isAvailable: Bool { embedFolder != nil }

    private var calm: Bool { reduceMotion || lowPower }

    // MARK: Hosts

    /// A screen that shows her figure came on. The last one to arrive shows the web view.
    func attach(host id: UUID, container: ShannonLive2DPlatformView, layout: ShannonLive2DLayout, touchEnabled: Bool) {
        hosts.removeAll { $0.id == id || $0.container == nil }
        hosts.append(Host(id: id, container: container, layout: layout, touchEnabled: touchEnabled))
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

    // MARK: Driving

    public func express(_ expression: String, feeling: String? = nil, seconds: Double? = nil) {
        noteActivity()
        send(.express(expression: expression, feeling: feeling, seconds: seconds))
    }

    public func expressEmotion(_ name: String, intensity: Double) {
        noteActivity()
        send(.expressEmotion(name: name, intensity: intensity))
    }

    public func setMood(valence: Double, arousal: Double, openness: Double) {
        mood = (valence, arousal, openness)
        send(.setMood(valence: valence, arousal: arousal, openness: openness))
    }

    public func setPresence(_ value: ShannonLive2DPresence) {
        guard presence != value else { return }
        // More stories waiting makes her fidget: that is worth waking a resting figure for.
        if value.awaitingReaction > (presence?.awaitingReaction ?? 0) { noteActivity() }
        presence = value
        send(.setPresence(value))
    }

    public func setPhase(_ value: ShannonLive2DPhase) {
        guard phase != value else { return }
        phase = value
        noteActivity()
        send(.setPhase(value))
        if value != .speaking { lastMouthLevel = 0 }
    }

    /// The level of the audio being played, 0–1. Zero when speech ends.
    public func setMouthLevel(_ level: Double) {
        let clamped = min(1, max(0, level.isFinite ? level : 0))
        guard status == .ready, sentPaused == false || clamped <= 0,
              ShannonLive2DStagePolicy.sendsMouthLevel(clamped, last: lastMouthLevel) else { return }
        lastMouthLevel = clamped
        if clamped > 0 { lastActivityAt = Date() }
        send(.setMouthLevel(clamped))
    }

    public func play(_ gesture: String) {
        guard gestures.contains(gesture) else { return }
        noteActivity()
        send(.play(gesture))
    }

    /// Frames per second, reported every five seconds while a diagnostics view asks for it.
    public func setFrameStats(_ enabled: Bool) {
        frameStats = enabled
        if !enabled { framesPerSecond = nil }
        send(.setFrameStats(enabled))
    }

    /// The owner asked for another try after a failure.
    public func retry() {
        lastReloadAt = nil
        release()
        guard !hosts.isEmpty else { return }
        load()
        mount()
    }

    /// Something happened that a resting figure should move for: a touch, a new face, a phase.
    func noteActivity() {
        lastActivityAt = Date()
        if isResting { isResting = false }
        refreshPaused()
        scheduleRest()
    }

    private func send(_ command: ShannonLive2DCommand) {
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

    private func scheduleRest() {
        restTask?.cancel()
        restTask = nil
        guard calm, status == .ready, activeHost != nil else { return }
        restTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                guard self.calm, self.status == .ready, self.activeHost != nil else { return }
                if ShannonLive2DStagePolicy.rests(calm: true, phase: self.phase, idleSeconds: Date().timeIntervalSince(self.lastActivityAt)) {
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
        sentPaused = nil
        lastMouthLevel = 0
        loadStartedAt = Date()

        let bridge = ShannonLive2DBridge(stage: self, generation: generation, folder: folder)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(bridge, name: ShannonLive2DBridge.handlerName)
        // The page does not handle a lost WebGL context itself; it is reported here as an error and the page reloads.
        configuration.userContentController.addUserScript(WKUserScript(
            source: ShannonLive2DBridge.contextLossScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
            let rules = try? await WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "shannon-live2d-offline", encodedContentRuleList: ShannonLive2DBridge.offlineRules)
            guard let self, let webView, self.generation == generation, self.webView === webView else { return }
            if let rules { webView.configuration.userContentController.add(rules) }
            webView.loadFileURL(folder.appendingPathComponent("embed.html"), allowingReadAccessTo: folder)
        }

        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            // Only time in the foreground counts: a page in a backgrounded app is suspended, not broken.
            var waited = 0.0
            while waited < ShannonLive2DStagePolicy.loadTimeoutSeconds {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, self.generation == generation, self.status == .loading else { return }
                if self.appActive { waited += 1 }
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
        sentPaused = nil
        isResting = false
        framesPerSecond = nil
        lastMouthLevel = 0
        status = .unloaded
    }

    /// The page failed, lost its drawing context, or its process ended: one reload, then an honest failure.
    fileprivate func recover(generation failed: Int) {
        guard failed == generation else { return }
        let now = Date()
        let mayReload = ShannonLive2DStagePolicy.mayReload(lastReloadAt: lastReloadAt, now: now)
        release()
        guard mayReload, !hosts.isEmpty else {
            status = hosts.isEmpty ? .unloaded : .failed
            return
        }
        lastReloadAt = now
        load()
        mount()
    }

    fileprivate func receive(_ message: ShannonLive2DMessage, generation received: Int) {
        guard received == generation else { return }
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewBodyStats") {
            let seconds = loadStartedAt.map { Date().timeIntervalSince($0) } ?? 0
            NSLog("[ShannonBody] %@ (%.2f s after load began)", String(describing: message).prefix(160).description, seconds)
        }
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
            status = .ready
            if let mood { send(.setMood(valence: mood.valence, arousal: mood.arousal, openness: mood.openness)) }
            if let presence { send(.setPresence(presence)) }
            send(.setPhase(phase))
            if frameStats { send(.setFrameStats(true)) }
            applyHost()
            refreshPaused()
            lastActivityAt = Date()
            scheduleRest()
        case .error:
            recover(generation: received)
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
        let center = NotificationCenter.default
        lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.calmChanged(lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled) }
        }
#if canImport(UIKit)
        reduceMotion = UIAccessibility.isReduceMotionEnabled
        appActive = UIApplication.shared.applicationState == .active
        center.addObserver(forName: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.calmChanged(reduceMotion: UIAccessibility.isReduceMotionEnabled) }
        }
        center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.activeChanged(false) }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.activeChanged(true) }
        }
        center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.memoryWarning() }
        }
#elseif canImport(AppKit)
        reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        appActive = !NSApplication.shared.isHidden
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.calmChanged(reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion) }
        }
        center.addObserver(forName: NSApplication.didHideNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.activeChanged(false) }
        }
        center.addObserver(forName: NSApplication.didUnhideNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.activeChanged(true) }
        }
#endif
    }

    private func calmChanged(reduceMotion: Bool? = nil, lowPower: Bool? = nil) {
        if let reduceMotion { self.reduceMotion = reduceMotion }
        if let lowPower { self.lowPower = lowPower }
        noteActivity()
    }

    private func activeChanged(_ active: Bool) {
        appActive = active
        refreshPaused()
        guard active else { return }
        noteActivity()
        checkDrawingContext()
    }

    /// With no screen showing her, the model is let go at once; a visible figure is left to the system,
    /// which ends the page's process if it must (and the page then reloads once).
    private func memoryWarning() {
        guard hosts.isEmpty, status != .unloaded else { return }
        release()
    }

    /// After a return from the background the drawing context may be gone without an event having been seen.
    private func checkDrawingContext() {
        guard status == .ready, let webView else { return }
        let generation = generation
        webView.evaluateJavaScript(ShannonLive2DBridge.contextProbeScript) { [weak self] result, _ in
            guard (result as? String) == "lost" else { return }
            Task { @MainActor in self?.recover(generation: generation) }
        }
    }
}

/// Receives the page's messages and navigation events. The web view's content controller keeps
/// this object alive; it points back at the stage weakly, so the stage and the web view form no cycle.
@MainActor
private final class ShannonLive2DBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let handlerName = "shannonBody"
    static let contextLossScript = """
    document.addEventListener('webglcontextlost', function () {
      try { window.webkit.messageHandlers.shannonBody.postMessage({ type: 'error', message: 'webglcontextlost' }); } catch (e) {}
    }, true);
    """
    static let contextProbeScript = """
    (function () {
      var canvas = document.querySelector('#stage canvas');
      if (!canvas) { return 'none'; }
      var context = canvas.getContext('webgl2');
      return context && !context.isContextLost() ? 'ok' : 'lost';
    })();
    """
    static let offlineRules = #"[{"trigger":{"url-filter":"^(https?|wss?|ftp):"},"action":{"type":"block"}}]"#

    private weak var stage: ShannonLive2DStage?
    private let generation: Int
    private let folder: URL

    init(stage: ShannonLive2DStage, generation: Int, folder: URL) {
        self.stage = stage
        self.generation = generation
        self.folder = folder.resolvingSymlinksInPath()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName, let parsed = ShannonLive2DMessage(body: message.body) else { return }
        stage?.receive(parsed, generation: generation)
    }

    /// Only the bundled page: nothing else is ever navigated to.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url, url.isFileURL else { return .cancel }
        return url.resolvingSymlinksInPath().path.hasPrefix(folder.path + "/") ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        stage?.recover(generation: generation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        stage?.recover(generation: generation)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stage?.recover(generation: generation)
    }
}
