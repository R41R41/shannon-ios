import Foundation
import Observation
import SwiftUI

/// What the screens that show her figure share: whether the body screen is open, her face and
/// what she is doing in words, and the coordinator of touches. `ShannonBodyAttachment` keeps it
/// current and passes the same facts to the Live2D page.
@MainActor
@Observable
public final class ShannonBodyModel {
    /// The body screen 「からだ」. Any entry (the toolbar, a tile, her figure) sets this.
    public var showsScreen = false
    /// The same screen, opened from Settings (which is itself a cover over the workspace).
    public var showsScreenFromSettings = false
    public internal(set) var face = ShannonFace(expression: .calm)
    public internal(set) var doingLine: String?
    /// Someone else may be listening, or was a moment ago: touches are then reported as seen by others.
    var audienceRule = ShannonBodyAudienceRule()
    public var audience: ShannonBodyAudience { audienceRule.audience(at: Date()) }
    public internal(set) var touch: ShannonBodyTouchCoordinator
    @ObservationIgnored var isConnected = false

    public init(touch: ShannonBodyTouchCoordinator = ShannonBodyTouchCoordinator()) {
        self.touch = touch
    }

    /// Gives the touch coordinator the conversation's own client and scope, once.
    func connect(
        scopeKey: String, client: (any ShannonBodyServing)?,
        isDesignPreview: @escaping @MainActor @Sendable () -> Bool,
        othersMayBeListening: @escaping @MainActor @Sendable () -> Bool
    ) {
        guard !isConnected else { return }
        isConnected = true
        touch = ShannonBodyTouchCoordinator(scopeKey: scopeKey, client: client, environment: .init(
            // Read from the call itself at the moment of the touch, not from a value a view update left behind.
            audience: { [weak self] in
                guard let self else { return .others }
                self.audienceRule.observe(othersMayBeListening: othersMayBeListening(), at: Date())
                return self.audience
            },
            maySend: { !isDesignPreview() }
        ))
        ShannonLive2DStage.shared.onTouchMessage = { [weak self] message in
            self?.touch.handle(message)
        }
    }
}

/// Keeps the Live2D figure and the body model in step with what the app already knows, and
/// presents the body screen. Attached once, at the root of the conversation workspace, so its
/// environment reaches every sheet and cover. With the Waterlight form chosen it only keeps
/// the model's words current; nothing is sent to a page that is not loaded.
struct ShannonBodyAttachment: ViewModifier {
    let bodyModel: ShannonBodyModel
    let conversation: ShannonConversationModel
    let memory: ShannonMemoryModel
    let voice: ShannonGeminiLiveSessionModel

    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonBodyPreference.reportsTouchKey) private var reportsTouch = false
    @Environment(\.scenePhase) private var scenePhase
    /// Moves on so that a step of hers stops being shown once it is three minutes old.
    @State private var clock = Date()

    private var stage: ShannonLive2DStage { .shared }
    private var usesLive2D: Bool { formRawValue == ShannonForm.live2d.rawValue }

    private var callActivity: ShannonDialogueActivity? {
#if os(iOS)
        switch voice.phase {
        case .idle: nil
        case .listening: .listening
        case .thinking: .thinking
        case .speaking: .speaking
        case .requestingPermission, .connecting, .reconnecting, .failed: .waiting
        }
#else
        nil
#endif
    }

    /// 「友人も一緒」, or a companion the owner mentioned in an owner call.
    private var othersMayBeListening: Bool {
#if os(iOS)
        voice.othersMayBeListening
#else
        false
#endif
    }

    private var phase: ShannonLive2DPhase {
        ShannonBodySignals.phase(isSendingText: conversation.isSending, call: callActivity)
    }

    private var doing: ShannonBodyDoing {
        ShannonBodySignals.doing(loopState: memory.autonomy.overview?.loop?.state, days: memory.autonomy.days, now: clock)
    }

    private var awaitingReaction: Int {
        memory.autonomy.study.pieces.filter { $0.awaitingReaction == true }.count
    }

    private var presence: ShannonLive2DPresence {
        ShannonBodySignals.presence(state: conversation.state, doing: doing, awaitingReaction: awaitingReaction)
    }

    private var replyFace: ReplyFace? {
        conversation.messages.last(where: { $0.role == .shannon }).flatMap { message in
            message.emotionSnapshot.map { ReplyFace(id: message.id, face: $0.face) }
        }
    }

    private var callFeeling: CallFeeling {
#if os(iOS)
        CallFeeling(face: voice.callFace, emotion: voice.replyEmotion)
#else
        CallFeeling(face: nil, emotion: nil)
#endif
    }

    func body(content: Content) -> some View {
        feelings(signals(content))
            .environment(bodyModel)
            .modifier(ShannonBodyScreenPresentation(bodyModel: bodyModel, memory: memory))
            .task { connect() }
            .task(id: scenePhase) { await keepClock() }
            .onAppear {
                bodyModel.audienceRule.observe(othersMayBeListening: othersMayBeListening, at: Date())
                applyForm()
#if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewBody") { bodyModel.showsScreen = true }
#endif
            }
    }

    private func signals(_ content: Content) -> some View {
        content
            .onChange(of: formRawValue) { applyForm() }
            .onChange(of: stage.status) { if stage.status == .ready { pushAll() } }
            .onChange(of: conversation.state?.emotion) { pushMood() }
            .onChange(of: presence) { presenceChanged() }
            .onChange(of: phase) { phaseChanged() }
            .onChange(of: othersMayBeListening) { bodyModel.audienceRule.observe(othersMayBeListening: othersMayBeListening, at: Date()) }
            .onChange(of: reportsTouch) { bodyModel.touch.reportingChanged() }
            .onChange(of: scenePhase) { if scenePhase != .active { ShannonSpeechLevelPublisher.shared.end() } }
    }

    private func feelings(_ content: some View) -> some View {
        content
            .onChange(of: replyFace) { replyFaceChanged() }
            .onChange(of: callFeeling) { callFeelingChanged() }
            .onChange(of: conversation.presentFace) { refreshWords() }
    }

    private func connect() {
        let conversation = conversation
        let voice = voice
        bodyModel.connect(
            scopeKey: conversation.scopeKey, client: conversation.client as? any ShannonBodyServing,
            isDesignPreview: { [weak conversation] in conversation?.isDesignPreview ?? true },
            othersMayBeListening: { [weak voice] in Self.othersMayBeListening(voice) }
        )
        refreshWords()
        pushAll()
    }

    private static func othersMayBeListening(_ voice: ShannonGeminiLiveSessionModel?) -> Bool {
#if os(iOS)
        voice?.othersMayBeListening ?? false
#else
        false
#endif
    }

    private func keepClock() async {
        guard scenePhase == .active else { return }
        if usesLive2D { await memory.autonomy.loadIfNeeded() }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(30))
            clock = Date()
        }
    }

    private func presenceChanged() {
        refreshWords()
        if usesLive2D { stage.setPresence(presence) }
    }

    private func phaseChanged() {
        refreshWords()
        guard usesLive2D else { return }
        stage.setPhase(phase)
        if phase != .speaking { stage.setMouthLevel(0) }
    }

    private func replyFaceChanged() {
        refreshWords()
        guard usesLive2D, callActivity == nil, let face = replyFace?.face else { return }
        stage.express(face.expression.rawValue, feeling: face.feeling?.rawValue)
    }

    private func callFeelingChanged() {
        refreshWords()
        guard usesLive2D else { return }
        // The voice's own emotion has more faces than the 22 the app draws; the turn's face is the fallback.
        if let emotion = callFeeling.emotion {
            stage.expressEmotion(emotion.primary, intensity: emotion.intensity)
        } else if let face = callFeeling.face {
            stage.express(face.expression.rawValue, feeling: face.feeling?.rawValue)
        }
    }

    /// Her mouth follows the played speech only while the Live2D form is the one in use.
    private func applyForm() {
        if usesLive2D, ShannonLive2DStage.isAvailable {
            ShannonSpeechLevelPublisher.shared.setSink { level in ShannonLive2DStage.shared.setMouthLevel(level) }
            pushAll()
        } else {
            ShannonSpeechLevelPublisher.shared.setSink(nil)
            bodyModel.touch.clearLine()
        }
    }

    private func pushAll() {
        guard usesLive2D else { return }
        pushMood()
        stage.setPresence(presence)
        stage.setPhase(phase)
    }

    private func pushMood() {
        guard usesLive2D, let emotion = conversation.state?.emotion else { return }
        stage.setMood(valence: emotion.valence, arousal: emotion.arousal, openness: emotion.openness)
    }

    private func refreshWords() {
#if os(iOS)
        let callFace = voice.phase != .idle ? voice.callFace : nil
#else
        let callFace: ShannonFace? = nil
#endif
        bodyModel.face = callFace ?? (conversation.isSending ? conversation.currentFace : conversation.presentFace)
        bodyModel.doingLine = ShannonBodySignals.doingLine(phase: phase, doing: doing, awaitingReaction: awaitingReaction)
    }

    private struct ReplyFace: Equatable {
        let id: UUID
        let face: ShannonFace
    }

    private struct CallFeeling: Equatable {
        let face: ShannonFace?
        let emotion: ShannonVoiceTurnEmotionDTO?
    }
}
