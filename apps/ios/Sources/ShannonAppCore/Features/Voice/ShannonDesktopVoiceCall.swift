#if os(macOS)
import AppKit
import Foundation
import Observation

/// The Mac's voice conversation (roadmap A16): the iPhone's call (`ShannonGeminiLiveSessionModel`, started and
/// ended through `ShannonVoiceWorkspaceState` exactly as there), held once for the app so that it outlives
/// the page and the window it was started from.
///
/// What the iPhone's system gives it, the Mac does here:
/// - *Background.* The app counts as in the background while another app is in front: after one minute
///   without speech from either side the call ends as 終了 does (`ShannonVoiceBackgroundSilence`), and Talk
///   says so when the owner comes back.
/// - *Elsewhere* (owner decision 2026-10-06, option B). On every page a row at the bottom of the sidebar
///   shows the call (`ShannonDesktopVoiceCallRow`); while no window is on screen (hidden, minimised, covered)
///   the call is in the menu bar (`ShannonDesktopVoiceCallMenuSection`). Closing the last window still ends
///   the call, so a microphone is never left open with nothing of the app to stop it.
/// - *Who holds the sound.* Her messages through the earphones and her spoken line for a touch wait while
///   a call or dictation holds the microphone (`ShannonSpeechArbiter`).
/// - *The other devices.* The call is reported as `callStarted` / `callEnded` (`ShannonVoiceCallPresence`) so
///   that her desktop body keeps its wake listener closed during a Mac call.
@MainActor
@Observable
public final class ShannonDesktopVoiceCall {
    public let session: ShannonGeminiLiveSessionModel
    let workspace = ShannonVoiceWorkspaceState()
    /// Shown in Talk once a call ended by itself (one silent minute while another app was in front).
    public internal(set) var notice: String?
    /// Dictation in Talk's composer (音声入力): the iPhone's recorder, transcribed by the server into the draft.
    public let dictation = ShannonVoiceConversationModel()

    /// A window of the app is on screen (not hidden, not minimised, not covered or on another Space). While a
    /// call is on and none is, the call is in the menu bar (owner decision 2026-10-06, option B).
    public internal(set) var windowsOnScreen = true
    @ObservationIgnored var windowsOnScreenProbe: @MainActor () -> Bool = ShannonDesktopVoiceCall.anyWindowOnScreen
    @ObservationIgnored var menuSection: ShannonDesktopVoiceCallMenuSection?
    @ObservationIgnored var windowObservers: [NSObjectProtocol] = []
    /// What was in Talk's draft when a friend joined: set aside, put back when the call returns to 本人だけ or ends.
    @ObservationIgnored var ownerDraftAside: String?
    /// The window the owner used last: トークに戻る brings this one back.
    @ObservationIgnored weak var lastMainWindow: NSWindow?
    /// The windows that show the app's root view, by root view (`window(_:hosts:)`).
    @ObservationIgnored var windowHosts: [UUID: DesktopWindowRef] = [:]
    /// Opens a new window on Talk, for トークに戻る when no window of the app can be brought back. Set by the app.
    @ObservationIgnored public var openTalkWindow: (@MainActor () -> Void)?

    @ObservationIgnored private(set) weak var conversation: ShannonConversationModel?
    @ObservationIgnored private var windows: Set<UUID> = []
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    /// How long the last window may be gone before the call ends: a window rebuilt in place comes straight back.
    @ObservationIgnored var lastWindowGrace: Duration = .seconds(1)

    public init(session: ShannonGeminiLiveSessionModel = ShannonGeminiLiveSessionModel()) {
        self.session = session
    }

    /// A call is on screen: connecting, live, or failed and waiting for もう一度つなぐ or 終了.
    public var isShown: Bool { session.phase != .idle }
    /// The call holds the microphone. A failed call holds nothing.
    public var holdsMicrophone: Bool { session.phase != .idle && session.phase != .failed }
    /// Dictation is recording or being transcribed: the call does not start, and nothing else of hers speaks.
    /// A recording that stopped by itself at its longest (`.ready`) holds no microphone while it waits for the click.
    public var dictationHoldsMicrophone: Bool {
        [.requestingPermission, .listening, .transcribing].contains(dictation.phase)
    }
    /// Dictation stands in the way of a call: it holds the microphone, or a finished recording (`.ready`, after the
    /// automatic stop) waits for the owner's click to be written into the draft. A call never discards dictated speech.
    public var dictationBlocksCall: Bool {
        dictationHoldsMicrophone || dictation.phase == .ready
    }
    /// The Talk the call's turns are written to.
    public var threadID: String? { workspace.threadContext?.threadID }

    /// Connects the call to the app's conversation, once, and follows the app in and out of the foreground.
    /// `menuBar` is where the call shows itself while no window is on screen (nil in tests).
    public func attach(conversation: ShannonConversationModel, menuBar: ShannonDesktopMenuBar? = .shared) {
        guard self.conversation == nil else { return }
        self.conversation = conversation
        ShannonDesktopAppDelegate.voiceCall = self
        followWindows(menuBar: menuBar)
        let arbiter = ShannonSpeechArbiter.shared
        arbiter.sessionInUse = { [weak self] in
            guard let self else { return false }
            return self.holdsMicrophone || self.dictationHoldsMicrophone
        }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.session.sceneDidEnterBackground() }
        })
        observers.append(center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.becameActive() }
        })
        if !NSApplication.shared.isActive { session.sceneDidEnterBackground() }
        resendUndeliveredEnds()
    }

    /// 音声会話を開始 in Talk's composer: a call on the Talk in front (a new Talk when none is).
    public func start(threadID: String?) {
        guard let conversation, !holdsMicrophone, !dictationBlocksCall else { return }
        notice = nil
        // Two captures never run at once: a dictation error left on screen is cleared (dictated speech is never
        // dropped: the call waits for it, above), and her message through the earphones gives way too.
        dictation.cancel()
        ShannonSpeechArbiter.shared.microphoneWillBeTaken?()
        workspace.beginCall(
            mode: .owner, speechProvider: Self.speechProvider, threadID: threadID,
            conversationModel: conversation, geminiVoiceModel: session
        )
        installCallHooks()
    }

    /// 終了: what was answered stays stored, a 「友人も一緒」 period is remembered, and the card says so.
    public func end() {
        workspace.endCall(session)
        restoreOwnerDraft()
    }

    /// How long quitting waits for the end of a call to reach the server.
    static let quitLimit: Duration = .seconds(2)

    /// ⌘Q during a call: ends it as 終了 does, then waits until `callEnded` was sent and a 「友人も一緒」 period
    /// handed to the server, or the limit passed, whichever comes first.
    func endForQuit(limit: Duration = ShannonDesktopVoiceCall.quitLimit) async {
        guard isShown else { return }
        end()
        var sent = false
        Task { @MainActor in
            await ShannonVoiceCallPresence.shared.settle()
            sent = true
        }
        let deadline = ContinuousClock.now.advanced(by: limit)
        while ContinuousClock.now < deadline {
            if sent, (workspace.callMemory?.pending ?? 0) == 0 { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
        ShannonVoiceDiagnostics.shared.record("gemini.session.quit.timed_out")
    }

    /// The control between 本人だけ and 友人も一緒, after its confirmation. An unshared photo is dropped.
    func switchParticipant(to mode: ShannonVoiceParticipantMode) {
        guard mode != session.participantMode else { return }
        workspace.clearPhoto()
        session.switchParticipantMode(to: mode)
    }

    /// Text typed into Talk's composer during a call goes into the call.
    @discardableResult
    public func sendText(_ text: String) -> Bool {
        session.sendText(text)
    }

    /// The call switched between 本人だけ and 「友人も一緒」. Into 「友人も一緒」 everything in Talk's draft was typed
    /// outside it, so it is the owner's: set aside, neither shown nor sent with ⌘↩︎ as the guests' words. Back in
    /// 本人だけ (or when the call ends) it returns, ahead of anything typed for the guests meanwhile.
    func participantModeChanged(to mode: ShannonVoiceParticipantMode) {
        workspace.participantModeChanged(to: mode)
        if mode == .guest { setOwnerDraftAside() } else { restoreOwnerDraft() }
    }

    private func setOwnerDraftAside() {
        guard let conversation, !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        ownerDraftAside = [ownerDraftAside, conversation.draft].compactMap { $0 }.joined(separator: "\n")
        conversation.draft = ""
    }

    func restoreOwnerDraft() {
        guard let aside = ownerDraftAside, let conversation else { return }
        ownerDraftAside = nil
        conversation.draft = conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? aside : aside + "\n" + conversation.draft
    }

    /// The speech provider of 設定 › 声, read at the start of each call (「次の通話から反映」).
    static var speechProvider: ShannonSpeechProvider {
        UserDefaults.standard.string(forKey: ShannonSpeechProvider.storageKey).flatMap(ShannonSpeechProvider.init(rawValue:)) ?? .gemini
    }

    // MARK: Windows

    /// A window that can show the call appeared.
    public func windowAppeared(_ id: UUID) {
        windows.insert(id)
    }

    /// A window went away. When the last one is gone the call ends, as nothing on screen could stop it.
    public func windowDisappeared(_ id: UUID) {
        windows.remove(id)
        windowHosts[id] = nil
        guard windows.isEmpty, isShown else { return }
        let grace = lastWindowGrace
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: grace)
            guard let self, self.windows.isEmpty, self.isShown else { return }
            ShannonVoiceDiagnostics.shared.record("gemini.session.window_closed.ended")
            self.end()
        }
    }

    var windowCount: Int { windows.count }

    // MARK: Private

    private func becameActive() {
        session.sceneDidBecomeActive()
        resendUndeliveredEnds()
    }

    private func resendUndeliveredEnds() {
        guard let conversation, !conversation.isDesignPreview else { return }
        ShannonVoiceCallPresence.shared.resendUndelivered(
            scopeKey: conversation.scopeKey, reporter: conversation.client as? any ShannonBodyCallReporting)
    }

    /// A silent minute while another app is in front ends the call through 終了's path; Talk says so afterwards.
    func installCallHooks() {
        // The Mac's switch handler also clears the owner's failed text from Talk's draft.
        session.participantModeDidChange = { [weak self] mode in self?.participantModeChanged(to: mode) }
        session.endAfterBackgroundSilence = { [weak self] in
            guard let self else { return }
            self.end()
            self.notice = ShannonVoiceBackgroundCopy.endedAfterSilence
        }
    }
}

/// A window held weakly: closing it is never delayed by the call.
struct DesktopWindowRef {
    weak var window: NSWindow?
}
#endif
