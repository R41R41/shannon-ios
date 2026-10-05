#if os(macOS)
import AppKit
import Foundation
import Observation

public extension Notification.Name {
    /// The menu bar item asked a window to show one of the four entries (`userInfo["entry"]`, the entry's raw value).
    static let shannonDesktopOpenEntry = Notification.Name("ShannonDesktopOpenEntry")
}

/// The four entries of the app, as the menu bar item opens them.
public enum ShannonDesktopEntry: String, CaseIterable, Sendable {
    case talk, work, shannon, settings

    public var title: String {
        switch self {
        case .talk: ShannonGeneratedStrings.navTalk
        case .work: ShannonGeneratedStrings.navWork
        case .shannon: ShannonGeneratedStrings.navShannon
        case .settings: ShannonGeneratedStrings.navSettings
        }
    }
}

/// Her desktop body on the Mac (roadmap A17, Syzygy ADR-0004): she stands on the desktop in a transparent window of her
/// own, above other windows, in the same body page as everywhere (the one web view of `ShannonLive2DStage`).
///
/// The window is her full body (`docs/body-contract.md`): while it is up it reads her presence, registers what it can
/// do, reports who is at the Mac and what happened to her, says her own messages and the lines of a moment, and takes
/// one look at the room when she asks and the owner allows the camera. It speaks for a device of its own, derived from
/// the app's ("Her desktop body inside an app"), so the app's own voice calls stay the app's. Wake-name listening is not
/// here (Syzygy ADR-0002: Windows first).
@MainActor
@Observable
public final class ShannonDesktopBody {
    public static let shared = ShannonDesktopBody()

    /// Whether the server takes the window's requests as her body's (it answers with `X-Shannon-Body: desktop`).
    public enum Support: Equatable, Sendable {
        case unknown, supported, unsupported, notConnected
    }

    public private(set) var isShown = ShannonDesktopBodyPreference.isShown()
    public private(set) var alwaysOnTop = ShannonDesktopBodyPreference.alwaysOnTop()
    public private(set) var speaks = ShannonDesktopBodyPreference.speaks()
    public private(set) var smallEyes = ShannonDesktopBodyPreference.smallEyes()
    public private(set) var cameraAllowed = ShannonDesktopBodyPreference.camera()
    /// Her size on the display she stands on.
    public internal(set) var scale = 1.0
    public internal(set) var support = Support.unknown
    /// Her words in the bubble: one of her own messages, a line of a moment, or what she said about the room.
    public internal(set) var line: ShannonBodyTouchCoordinator.Line?
    /// The camera is open for her one frame: 「いま見ています」.
    public internal(set) var isCapturing = false
    public internal(set) var cameraPermission = ShannonMediaPermission.currentVideoCapture()
    public internal(set) var hasCamera = true
    /// The owner is in a voice call on another of his apps (`ownerCallElsewhere`), or on this Mac.
    public internal(set) var ownerInCallElsewhere = false

    /// Opens a new window on one of the four entries, when no window of the app can be brought back. Set by the app.
    @ObservationIgnored public var openWindowForEntry: (@MainActor (ShannonDesktopEntry) -> Void)?
    @ObservationIgnored weak var conversation: ShannonConversationModel?
    @ObservationIgnored weak var voiceCall: ShannonDesktopVoiceCall?
    @ObservationIgnored var client: (any ShannonDesktopBodyServing)?
    @ObservationIgnored var window: ShannonDesktopBodyWindowController?
    @ObservationIgnored public private(set) var touch = ShannonBodyTouchCoordinator()
    @ObservationIgnored var voice: ShannonBodyVoice?
    @ObservationIgnored var audienceRule = ShannonBodyAudienceRule(defaults: .standard)
    @ObservationIgnored var away = ShannonDesktopBodyAway()
    @ObservationIgnored var nudgeClock = ShannonDesktopBodyNudgeClock()
    @ObservationIgnored let macState = ShannonDesktopBodyMacState()
    @ObservationIgnored var loop: Task<Void, Never>?
    @ObservationIgnored var minuteTask: Task<Void, Never>?
    @ObservationIgnored var lineTask: Task<Void, Never>?
    @ObservationIgnored var speechQueue: Task<Void, Never>?
    @ObservationIgnored var menuSection: ShannonDesktopBodyMenuSection?
    @ObservationIgnored var etag: String?
    @ObservationIgnored var registeredCamera: Bool?
    @ObservationIgnored var lastReachOutID: String?
    @ObservationIgnored var awaitingReaction = 0
    @ObservationIgnored var looksTaken: [Date] = []
    @ObservationIgnored var answeredLooks: Set<String> = []
    @ObservationIgnored var lastCarryAskAt: Date?
    @ObservationIgnored var started = false
    @ObservationIgnored var reportedAppStarted = false

    init() {}

    /// Connects the body to the app's conversation and call, once. Nothing is shown or sent yet.
    public func configure(conversation: ShannonConversationModel, voiceCall: ShannonDesktopVoiceCall) {
        guard self.conversation == nil else { return }
        self.conversation = conversation
        self.voiceCall = voiceCall
        if let api = conversation.client as? ShannonAPIClient {
            client = ShannonDesktopBodyClient(api: api, camera: { ShannonDesktopBody.shared.registersCamera })
        }
        makeTouchAndVoice(conversation: conversation, voiceCall: voiceCall)
    }

    /// After launch: the menu bar item, and her window if the owner left her out (`showsWindow` false keeps it hidden
    /// for this run, as in the design preview).
    public func start(showsWindow: Bool = true, menuBar: ShannonDesktopMenuBar = .shared) {
        guard !started else { return }
        started = true
        let section = ShannonDesktopBodyMenuSection(body: self, menuBar: menuBar)
        menuSection = section
        menuBar.register(section)
        if isShown, showsWindow { show() }
    }

    // MARK: The owner's settings

    public func setShown(_ shown: Bool) {
        // Said while she is still there to say it.
        if !shown, isShown { report(plain: "windowHidden") }
        UserDefaults.standard.set(shown, forKey: ShannonDesktopBodyPreference.shownKey)
        isShown = shown
        shown ? show() : hide()
        menuSection?.refresh()
    }

    public func setAlwaysOnTop(_ value: Bool) {
        UserDefaults.standard.set(value, forKey: ShannonDesktopBodyPreference.alwaysOnTopKey)
        alwaysOnTop = value
        window?.applyLevel(alwaysOnTop: value)
    }

    public func setSpeaks(_ value: Bool) {
        UserDefaults.standard.set(value, forKey: ShannonDesktopBodyPreference.speaksKey)
        speaks = value
        if !value { stopSpeaking() }
    }

    public func setSmallEyes(_ value: Bool) {
        UserDefaults.standard.set(value, forKey: ShannonDesktopBodyPreference.smallEyesKey)
        smallEyes = value
        applySmallEyes()
    }

    /// Her size on the display she stands on (from the menu, 設定 › すがた, or ⌘ and a scroll over her).
    public func setScale(_ value: Double) {
        let clamped = ShannonDesktopBodyGeometry.clampScale(value)
        scale = clamped
        window?.resize(scale: clamped)
        applySmallEyes()
    }

    /// 「シャノンがカメラで部屋を見てよい」. Switching it on asks the system for the camera when it has not been asked:
    /// it is the owner's own click, so the prompt is his to answer.
    public func setCameraAllowed(_ value: Bool) async {
        if value, ShannonMediaPermission.currentVideoCapture() == .undetermined {
            _ = await ShannonAppLookSystemCamera.requestAccess()
        }
        cameraPermission = ShannonMediaPermission.currentVideoCapture()
        UserDefaults.standard.set(value, forKey: ShannonDesktopBodyPreference.cameraKey)
        cameraAllowed = value
        await registerIfNeeded(force: true)
    }

    /// The flag the body registers (`flags.camera`).
    var registersCamera: Bool {
        ShannonDesktopBodyLookRules.registersCamera(cameraAllowed: cameraAllowed, permission: cameraPermission, hasCamera: hasCamera)
    }

    /// Who could see or hear her: 「友人も一緒」 on the Mac's call, and the minutes after it, are others.
    var audience: ShannonBodyAudience {
        audienceRule.observe(othersMayBeListening: voiceCall?.session.othersMayBeListening ?? false, at: Date())
        audienceRule.save(to: .standard)
        return audienceRule.audience(at: Date())
    }

    /// The camera's state at her feet.
    public var cameraState: ShannonAppLookVisibleState {
        ShannonDesktopBodyCameraState.make(
            cameraAllowed: cameraAllowed, permission: cameraPermission, hasCamera: hasCamera,
            othersPresent: audienceRule.audience(at: Date()) == .others, isCapturing: isCapturing)
    }

    /// 「いまは小さいので、目だけで出ています。」 while it applies.
    public var showsEyesBecauseSmall: Bool {
        isShown && smallEyes && scale < ShannonDesktopBodyGeometry.smallEyesBelow && ShannonLive2DStage.shared.offersEyes
    }

    func applySmallEyes() {
        ShannonLive2DStage.shared.setDesktopBodyOverride(showsEyesBecauseSmall ? .eyes : nil)
    }

    var mayBeHeard: Bool { !(conversation?.isDesignPreview ?? true) && support == .supported && isShown }

    /// One of the four entries from the menu bar item: the window the owner used last comes back (unhidden, out of the
    /// Dock) and shows it; with none, a new window opens on it.
    func open(_ entry: ShannonDesktopEntry) {
        let app = NSApplication.shared
        if app.isHidden { app.unhide(nil) }
        app.activate()
        guard let voiceCall, let window = ShannonDesktopVoiceCall.windowToReturnTo(hosts: voiceCall.rootWindows, last: voiceCall.lastMainWindow) else {
            openWindowForEntry?(entry)
            return
        }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NotificationCenter.default.post(name: .shannonDesktopOpenEntry, object: window, userInfo: ["entry": entry.rawValue])
    }

    // MARK: Her window

    func show() {
        let controller = window ?? ShannonDesktopBodyWindowController(body: self)
        window = controller
        controller.show(alwaysOnTop: alwaysOnTop)
        ShannonLive2DStage.shared.setDesktopTouchHandler { [weak self] message in self?.touch.handle(message) }
        applySmallEyes()
        macState.start()
        startLoops()
        // Before the first read the server has not said that it hears her as a body: that read says it then.
        if support == .supported { report(plain: "windowShown") }
    }

    func hide() {
        stopSpeaking()
        loop?.cancel()
        minuteTask?.cancel()
        loop = nil
        minuteTask = nil
        etag = nil
        window?.hide()
        ShannonLive2DStage.shared.setDesktopTouchHandler(nil)
        ShannonLive2DStage.shared.setDesktopBodyOverride(nil)
        macState.stop()
    }

    // MARK: Touch and voice

    private func makeTouchAndVoice(conversation: ShannonConversationModel, voiceCall: ShannonDesktopVoiceCall) {
        let voice = ShannonBodyVoice(
            streamSpeech: { [weak conversation] text, style, provider in
                guard let conversation else { throw CancellationError() }
                return try await conversation.streamSpeech(text, style: style, provider: provider)
            },
            // A call here or on another of his apps (`ownerCallElsewhere`): she says nothing aloud through her body.
            callIsActive: { [weak self, weak voiceCall] in (voiceCall?.holdsMicrophone ?? false) || (self?.ownerInCallElsewhere ?? false) }
        )
        voice.mayAnswerInVoice = { [weak self] in self?.isShown ?? false }
        voice.listen = voiceCall.bodyListen { [weak self] in self?.answersTouchInVoice ?? false }
        self.voice = voice
        var environment = ShannonBodyTouchCoordinator.Environment(
            audience: { [weak self] in self?.audience ?? .others },
            maySend: { [weak self] in self?.mayBeHeard ?? false })
        environment.repliesInVoice = { [weak self, weak voice] in (self?.answersTouchInVoice ?? false) && (voice?.canSpeakNow ?? false) }
        environment.speak = { [weak self] line, heard in
            guard let self, let voice = self.voice else { return heard(false) }
            await self.withSpeakingPhase { await voice.say(line, heard: heard) }
        }
        environment.stopSpeaking = { [weak voice] in voice?.stop() }
        touch = ShannonBodyTouchCoordinator(scopeKey: conversation.scopeKey, client: client, environment: environment)
    }

    /// Her words for a touch are said aloud, and his answer listened for: 声で返す, 伝える on, the owner alone, her window
    /// up, and no call of his on another app (a Mac call for her answer would talk over it).
    var answersTouchInVoice: Bool {
        Self.answersTouchInVoice(
            shown: isShown, replyMode: ShannonBodyReplyMode.current(), reportsTouch: ShannonBodyPreference.reportsTouch(),
            audience: audience, ownerInCallElsewhere: ownerInCallElsewhere)
    }

    nonisolated static func answersTouchInVoice(
        shown: Bool, replyMode: ShannonBodyReplyMode, reportsTouch: Bool, audience: ShannonBodyAudience, ownerInCallElsewhere: Bool
    ) -> Bool {
        shown && replyMode == .voice && reportsTouch && audience == .owner && !ownerInCallElsewhere
    }

    /// She was put down after being carried (`carry`, `docs/body-contract.md`): asked about once she is down, at most
    /// one question in 45 seconds, never during a call or while she speaks; the finished touch is always reported.
    func carried(durationMs: Int) {
        let id = "carry-\(UUID().uuidString.lowercased())"
        let now = Date()
        let started = now.addingTimeInterval(-Double(durationMs) / 1000)
        let touch = ShannonLive2DTouch(
            id: id, occurredAt: Self.timestamp(started), kind: .carry, durationMs: durationMs, strength: 0.5, ongoing: false)
        let calm = !(voiceCall?.holdsMicrophone ?? false) && line == nil && !self.touch.isSpeaking
        if calm, now.timeIntervalSince(lastCarryAskAt ?? .distantPast) >= 45 {
            lastCarryAskAt = now
            self.touch.handle(.askReaction(touch))
        }
        self.touch.handle(.touch(touch))
    }

    // MARK: Her words in the bubble

    /// Shows one line of hers in the bubble, and says it when `speak` is true. Answers whether any of it was heard.
    @discardableResult
    func say(_ text: String, id: String, expression: String?, feeling: String? = nil, speak: Bool) async -> Bool {
        let trimmed = String(text.prefix(160))
        guard !trimmed.isEmpty else { return false }
        if let expression { ShannonLive2DStage.shared.express(expression, feeling: feeling, seconds: ShannonDesktopBodyBubble.seconds(for: trimmed)) }
        var shown = ShannonBodyTouchCoordinator.Line(id: id, text: trimmed, face: nil)
        shown.isSpoken = speak
        line = shown
        lineTask?.cancel()
        var heard = false
        if speak, let voice {
            await withSpeakingPhase { await voice.say(shown) { heard = $0 } }
            if !heard, line?.id == id { line?.isSpoken = false }
        }
        let hold = ShannonDesktopBodyBubble.seconds(for: trimmed)
        lineTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(heard ? 3 : hold))
            guard !Task.isCancelled, let self, self.line?.id == id else { return }
            self.line = nil
        }
        return heard
    }

    func stopSpeaking() {
        voice?.stop()
        lineTask?.cancel()
        line = nil
        touch.clearLine()
    }

    /// Her figure is in the speaking phase and her mouth follows her voice while a line of hers is said.
    func withSpeakingPhase(_ work: () async -> Void) async {
        let stage = ShannonLive2DStage.shared
        ShannonSpeechLevelPublisher.shared.setSink { level in ShannonLive2DStage.shared.setMouthLevel(level) }
        stage.setPhase(.speaking)
        await work()
        stage.setMouthLevel(0)
        if !(voiceCall?.holdsMicrophone ?? false) { stage.setPhase(.idle) }
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
#endif
