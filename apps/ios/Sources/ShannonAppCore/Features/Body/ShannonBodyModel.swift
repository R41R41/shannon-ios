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
    public internal(set) var face = ShannonFace(expression: .calm)
    public internal(set) var doingLine: String?
    /// 「友人も一緒」: touches are then reported as seen by others.
    public internal(set) var audience: ShannonBodyAudience = .owner
    public internal(set) var touch: ShannonBodyTouchCoordinator
    @ObservationIgnored var isConnected = false

    public init(touch: ShannonBodyTouchCoordinator = ShannonBodyTouchCoordinator()) {
        self.touch = touch
    }

    /// Gives the touch coordinator the conversation's own client and scope, once.
    func connect(scopeKey: String, client: (any ShannonBodyServing)?, isDesignPreview: @escaping @MainActor @Sendable () -> Bool) {
        guard !isConnected else { return }
        isConnected = true
        touch = ShannonBodyTouchCoordinator(scopeKey: scopeKey, client: client, environment: .init(
            audience: { [weak self] in self?.audience ?? .others },
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
    let body: ShannonBodyModel
    let conversation: ShannonConversationModel
    let memory: ShannonMemoryModel
    let voice: ShannonGeminiLiveSessionModel

    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonBodyPreference.reportsTouchKey) private var reportsTouch = false
    @Environment(\.scenePhase) private var scenePhase

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

    private var isGuestCall: Bool {
#if os(iOS)
        voice.phase != .idle && voice.participantMode == .guest
#else
        false
#endif
    }

    private var phase: ShannonLive2DPhase {
        ShannonBodySignals.phase(isSendingText: conversation.isSending, call: callActivity)
    }

    private var doing: ShannonBodyDoing {
        ShannonBodySignals.doing(loopState: memory.autonomy.overview?.loop?.state, days: memory.autonomy.days, now: Date())
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
        content
            .environment(body)
            .modifier(ShannonBodyScreenPresentation(body: body, memory: memory))
            .task {
                body.connect(
                    scopeKey: conversation.scopeKey, client: conversation.client as? any ShannonBodyServing,
                    isDesignPreview: { [weak conversation] in conversation?.isDesignPreview ?? true }
                )
                refreshWords()
                pushAll()
            }
            .onChange(of: formRawValue) { applyForm() }
            .onChange(of: stage.status) { if stage.status == .ready { pushAll() } }
            .onChange(of: conversation.state?.emotion) { pushMood() }
            .onChange(of: presence) {
                refreshWords()
                if usesLive2D { stage.setPresence(presence) }
            }
            .onChange(of: phase) {
                refreshWords()
                guard usesLive2D else { return }
                stage.setPhase(phase)
                if phase != .speaking { stage.setMouthLevel(0) }
            }
            .onChange(of: replyFace) {
                refreshWords()
                guard usesLive2D, callActivity == nil, let face = replyFace?.face else { return }
                stage.express(face.expression.rawValue, feeling: face.feeling?.rawValue)
            }
            .onChange(of: callFeeling) {
                refreshWords()
                guard usesLive2D else { return }
                // The voice's own emotion has more faces than the 22 the app draws; the turn's face is the fallback.
                if let emotion = callFeeling.emotion {
                    stage.expressEmotion(emotion.primary, intensity: emotion.intensity)
                } else if let face = callFeeling.face {
                    stage.express(face.expression.rawValue, feeling: face.feeling?.rawValue)
                }
            }
            .onChange(of: conversation.presentFace) { refreshWords() }
            .onChange(of: isGuestCall) { body.audience = isGuestCall ? .others : .owner }
            .onChange(of: reportsTouch) { body.touch.reportingChanged() }
            .onChange(of: scenePhase) { if scenePhase != .active { ShannonSpeechLevelPublisher.shared.end() } }
            .onAppear {
                body.audience = isGuestCall ? .others : .owner
                applyForm()
            }
    }

    /// Her mouth follows the played speech only while the Live2D form is the one in use.
    private func applyForm() {
        if usesLive2D, ShannonLive2DStage.isAvailable {
            ShannonSpeechLevelPublisher.shared.setSink { level in ShannonLive2DStage.shared.setMouthLevel(level) }
            pushAll()
        } else {
            ShannonSpeechLevelPublisher.shared.setSink(nil)
            body.touch.clearLine()
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
        body.face = callFace ?? (conversation.isSending ? conversation.currentFace : conversation.presentFace)
        body.doingLine = ShannonBodySignals.doingLine(phase: phase, doing: doing, awaitingReaction: awaitingReaction)
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
