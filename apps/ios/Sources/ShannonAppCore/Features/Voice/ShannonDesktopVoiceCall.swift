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
/// - *Leaving.* Closing the last window ends the call (there is no compact presence of the call yet, so
///   a microphone is never left open without a window to stop it). Hiding the app or minimising the
///   window keeps the call; macOS shows its microphone indicator meanwhile.
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
    public var dictationHoldsMicrophone: Bool {
        [.requestingPermission, .listening, .ready, .transcribing].contains(dictation.phase)
    }
    /// The Talk the call's turns are written to.
    public var threadID: String? { workspace.threadContext?.threadID }

    /// Connects the call to the app's conversation, once, and follows the app in and out of the foreground.
    public func attach(conversation: ShannonConversationModel) {
        guard self.conversation == nil else { return }
        self.conversation = conversation
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
        guard let conversation, !holdsMicrophone else { return }
        notice = nil
        // Two captures never run at once: dictation that is still open gives way to the call.
        dictation.cancel()
        workspace.beginCall(
            mode: .owner, speechProvider: Self.speechProvider, threadID: threadID,
            conversationModel: conversation, geminiVoiceModel: session
        )
        installEndAfterSilence()
    }

    /// 終了: what was answered stays stored, a 「友人も一緒」 period is remembered, and the card says so.
    public func end() {
        workspace.endCall(session)
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
    func installEndAfterSilence() {
        session.endAfterBackgroundSilence = { [weak self] in
            guard let self else { return }
            self.end()
            self.notice = ShannonVoiceBackgroundCopy.endedAfterSilence
        }
    }
}
#endif
