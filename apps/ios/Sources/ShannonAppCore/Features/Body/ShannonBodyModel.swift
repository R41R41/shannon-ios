import Foundation
import Observation
import SwiftUI

/// What the screens that show her figure share: whether her figure in Talk's dialogue display is
/// what the owner sees, her face and what she is doing in words, how her figure is scaled and moved,
/// and the coordinator of touches. `ShannonBodyAttachment` keeps it current and passes the same facts
/// to the Live2D page. (Decision 2026-10-03: からだ is a display of Talk, not a screen of its own.)
@MainActor
@Observable
public final class ShannonBodyModel {
    /// Talk is in front in its dialogue display and nothing covers it (no sheet, cover, call screen or
    /// picker): her figure there is what the owner sees. Set by the conversation root. This is the
    /// surface that may answer a touch in voice, as the body screen 「からだ」 was before.
    public internal(set) var dialogueIsInFront = false
    /// The sheets and confirmations opened from her words (what she took in from a turn) that are over her
    /// figure now, one id per list of those words: one list closing its sheet does not uncover another's.
    private(set) var coversFromWords: Set<UUID> = []
    var sheetFromWordsIsUp: Bool { !coversFromWords.isEmpty }
    func setCoverFromWords(_ id: UUID, isUp: Bool) {
        guard coversFromWords.contains(id) != isUp else { return }
        if isUp { coversFromWords.insert(id) } else { coversFromWords.remove(id) }
    }
    /// Other sheets, pickers and confirmations that a view opened over the window (`shannonCoversFigure`):
    /// the Mac counts them, as her figure beside Talk is then not what the owner sees.
    private(set) var coversFromViews: Set<UUID> = []
    public var isCoveredByAView: Bool { !coversFromViews.isEmpty || sheetFromWordsIsUp }
    func setCoverFromView(_ id: UUID, isUp: Bool) {
        // Only a real change is written: a write invalidates every view that reads the covers.
        guard coversFromViews.contains(id) != isUp else { return }
        if isUp { coversFromViews.insert(id) } else { coversFromViews.remove(id) }
    }
    /// Her size and place in Talk after two fingers moved her; 「位置を戻す」 sets it back. Not kept across launches.
    public var figureAdjustment = ShannonLive2DLayout()
    /// Asks the conversation root to show Talk's dialogue display (「トークで姿を見る」, the small figure of an empty Talk).
    public private(set) var dialogueRequest = 0
    public func requestDialogue() { dialogueRequest &+= 1 }
    public internal(set) var face = ShannonFace(expression: .calm)
    public internal(set) var doingLine: String?
    /// Someone else may be listening, or was a moment ago: touches are then reported as seen by others.
    var audienceRule = ShannonBodyAudienceRule(defaults: .standard) {
        didSet { if audienceRule.othersUntil != oldValue.othersUntil { audienceRule.save(to: .standard) } }
    }
    /// On the Mac, also `others` while the stream output is on (roadmap A18 S5): people may be watching her.
    public var audience: ShannonBodyAudience {
#if os(macOS)
        ShannonStreamOutput.audience(streamOutputOn: ShannonStreamOutput.shared.othersPresent, held: audienceRule.audience(at: Date()))
#else
        audienceRule.audience(at: Date())
#endif
    }
    /// The app is in front. Her voice for a touch and the microphone after it never run in the background.
    @ObservationIgnored var sceneIsActive = true

    /// Talk still answers a touch in voice: its dialogue display with her figure is in front, 声で返す and 伝える
    /// are on, the Live2D form is chosen, the app is in front, and nobody else is around.
    var answersInVoice: Bool {
        Self.answersInVoice(
            dialogueIsInFront: dialogueIsInFront, sceneIsActive: sceneIsActive, audience: audience,
            replyMode: ShannonBodyReplyMode.current(), reportsTouch: ShannonBodyPreference.reportsTouch(), form: ShannonForm.current()
        )
    }

    /// Talk in front, in its dialogue display, with nothing over it.
    nonisolated static func dialogueIsInFront(page: ShannonWorkspacePage, displayMode: ShannonConversationDisplayMode, covered: Bool) -> Bool {
        page == .talk && displayMode == .dialogue && !covered
    }

    nonisolated static func dialogueIsInFront(page: ShannonWorkspacePage, displayMode: ShannonConversationDisplayMode, covers: ShannonDialogueCovers) -> Bool {
        dialogueIsInFront(page: page, displayMode: displayMode, covered: covers.isAny)
    }

    /// Every condition at once, so that none can be dropped unnoticed: the one rule for her voice after a touch.
    nonisolated static func answersInVoice(
        dialogueIsInFront: Bool, sceneIsActive: Bool, audience: ShannonBodyAudience,
        replyMode: ShannonBodyReplyMode, reportsTouch: Bool, form: ShannonForm
    ) -> Bool {
        dialogueIsInFront && sceneIsActive && audience == .owner && replyMode == .voice && reportsTouch && form == .live2d
    }

    /// Stops her spoken line; the listening call notices by itself (`answersInVoice`).
    func stopVoice() { voice?.stop() }
    public internal(set) var touch: ShannonBodyTouchCoordinator
    @ObservationIgnored var isConnected = false
    @ObservationIgnored var voice: ShannonBodyVoice?

    public init(touch: ShannonBodyTouchCoordinator = ShannonBodyTouchCoordinator()) {
        self.touch = touch
    }

    /// Gives the touch coordinator the conversation's own client and scope, once.
    func connect(
        scopeKey: String, client: (any ShannonBodyServing)?,
        isDesignPreview: @escaping @MainActor @Sendable () -> Bool,
        othersMayBeListening: @escaping @MainActor @Sendable () -> Bool,
        voice: ShannonBodyVoice? = nil,
        call: ShannonBodyTouchCoordinator.CallLine? = nil
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
        #if os(iOS)
        // A finger: strokes and resting touches end before the page's 0.6 s, so the app asks about them itself.
        touch.environment.asksAfterShortTouch = true
        #endif
        // A touch during a voice conversation here: asked about by the app, and her line said in the call.
        touch.environment.call = call
        self.voice = voice
        if let voice {
            voice.mayAnswerInVoice = { [weak self] in self?.answersInVoice ?? false }
            // Only where the surface answers in voice, and only while nothing else holds the sound.
            touch.environment.repliesInVoice = { [weak voice] in voice?.canSpeakNow ?? false }
            touch.environment.speak = { [weak voice] line, heard in
                guard let voice else { return heard(false) }
                await voice.say(line, heard: heard)
            }
            touch.environment.stopSpeaking = { [weak voice] in voice?.stop() }
        }
        ShannonLive2DStage.shared.onTouchMessage = { [weak self] message in
            self?.touch.handle(message)
        }
    }
}

/// Keeps the Live2D figure and the body model in step with what the app already knows. Attached
/// once, at the root of the conversation workspace, so its environment reaches every sheet and cover. With the Waterlight form chosen it only keeps
/// the model's words current; nothing is sent to a page that is not loaded.
struct ShannonBodyAttachment: ViewModifier {
    let bodyModel: ShannonBodyModel
    let conversation: ShannonConversationModel
    let memory: ShannonMemoryModel
    let voice: ShannonGeminiLiveSessionModel
    /// Opens the microphone for his answer after a spoken touch line (iPhone); nil where there is none.
    var listen: ShannonBodyVoice.Listen?

    @AppStorage(ShannonPersonaPreset.storageKey) private var presetRawValue = ShannonPersonaPreset.initialRawValue
    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonBodyPreference.reportsTouchKey) private var reportsTouch = false
    @AppStorage(ShannonBodyReplyMode.storageKey) private var replyModeRawValue = ShannonBodyReplyMode.text.rawValue
    @Environment(\.scenePhase) private var scenePhase
    /// Moves on so that a step of hers stops being shown once it is three minutes old.
    @State private var clock = Date()
    /// Worked out when the record, the loop's state or the clock changes, not on every render.
    @State private var doing = ShannonBodyDoing.idle

    private var stage: ShannonLive2DStage { .shared }
    private var usesLive2D: Bool { ShannonPersonaPreset.form(legacy: formRawValue, preset: presetRawValue) == .live2d }

    private var callActivity: ShannonDialogueActivity? {
        switch voice.phase {
        case .idle: nil
        case .listening: .listening
        case .thinking: .thinking
        case .speaking: .speaking
        // Not idle for the page: while a call is being set up or has failed, a touch asks for no words.
        case .requestingPermission, .connecting, .reconnecting: .connecting
        case .failed: .listening
        }
    }

    /// 「友人も一緒」, or a companion the owner mentioned in an owner call.
    private var othersMayBeListening: Bool {
        voice.othersMayBeListening
    }

    private var phase: ShannonLive2DPhase {
        // Her spoken line for a touch is speech like any other: no gesture of her own, and no second question meanwhile.
        bodyModel.touch.isSpeaking && callActivity == nil ? .speaking
            : ShannonBodySignals.phase(isSendingText: conversation.isSending, call: callActivity)
    }

    private var loopState: String? { memory.autonomy.overview?.loop?.state }
    private var activityStamp: String? { memory.autonomy.days.first?.entries.first?.id }

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
        CallFeeling(face: voice.callFace, emotion: voice.replyEmotion)
    }

    func body(content: Content) -> some View {
        feelings(signals(content))
            .environment(bodyModel)
            .task {
                bodyModel.sceneIsActive = scenePhase == .active
                connect()
            }
            .task(id: scenePhase) { await keepClock() }
            .onAppear {
                bodyModel.audienceRule.observe(othersMayBeListening: othersMayBeListening, at: Date())
                applyForm(reason: .launch)
            }
    }

    private func signals(_ content: Content) -> some View {
        content
            .onChange(of: formRawValue) { applyForm() }
            .onChange(of: presetRawValue) { applyForm() }
            .onChange(of: stage.status) { if stage.status == .ready { pushAll() } }
            .onChange(of: conversation.state?.emotion) { pushMood() }
            .onChange(of: presence) { presenceChanged() }
            .onChange(of: loopState) { refreshDoing() }
            .onChange(of: activityStamp) { refreshDoing() }
            .onChange(of: clock) { refreshDoing() }
            .onChange(of: phase) { phaseChanged() }
            .onChange(of: othersMayBeListening) { bodyModel.audienceRule.observe(othersMayBeListening: othersMayBeListening, at: Date()) }
            .onChange(of: reportsTouch) { bodyModel.touch.reportingChanged() }
            .onChange(of: scenePhase) { sceneChanged() }
            .onChange(of: answersInVoice) { if !answersInVoice { bodyModel.stopVoice() } }
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
            othersMayBeListening: { [weak voice] in Self.othersMayBeListening(voice) },
            voice: bodyVoice(), call: callLine()
        )
        refreshDoing()
        refreshWords()
        pushAll()
    }

    /// Her voice for a touch line: the conversation's own speech stream, silent while a call runs.
    private func bodyVoice() -> ShannonBodyVoice? {
        guard !conversation.isDesignPreview else { return nil }
        let conversation = conversation
        let call = voice
        let speaker = ShannonBodyVoice(
            streamSpeech: { [weak conversation] text, style, provider in
                guard let conversation else { throw CancellationError() }
                return try await conversation.streamSpeech(text, style: style, provider: provider)
            },
            callIsActive: { [weak call] in Self.callIsActive(call) }
        )
        speaker.listen = listen
        return speaker
    }

    /// The voice conversation of the iPhone, for a touch during it. His next utterance names the reaction (the link is
    /// armed while her line sounds), so the model hears her line before his words and the Talk keeps it before them.
    /// Not on the Mac: its figure beside Talk keeps the page's moments during a call.
    private func callLine() -> ShannonBodyTouchCoordinator.CallLine? {
#if os(iOS)
        guard !conversation.isDesignPreview else { return nil }
        let call = voice
        return .init(
            isLive: { [weak call] in Self.callIsActive(call) },
            mayHear: { [weak call] in call?.mayHearTouchLine ?? false },
            say: { [weak call] line in
                guard let call else { return false }
                ShannonBodyReactionLink.shared.arm(reactionID: line.reactionID, listenSeconds: line.listenSeconds)
                let sounded = await call.sayTouchLine(line.text)
                if !sounded { ShannonBodyReactionLink.shared.disarm() }
                return sounded
            }
        )
#else
        nil
#endif
    }

    private static func callIsActive(_ voice: ShannonGeminiLiveSessionModel?) -> Bool {
        guard let voice else { return false }
        return voice.phase != .idle && voice.phase != .failed
    }

    private static func othersMayBeListening(_ voice: ShannonGeminiLiveSessionModel?) -> Bool {
        voice?.othersMayBeListening ?? false
    }

    private func keepClock() async {
        guard scenePhase == .active else { return }
        if usesLive2D { await memory.autonomy.loadIfNeeded() }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(30))
            clock = Date()
            // While someone is listening the stored hold is pushed on, so that an app killed mid-call still holds.
            holdAudience()
        }
    }

    /// Read here so that leaving the dialogue display (or covering it), switching the mode or the reporting off,
    /// or the form, stops her voice at once.
    private var answersInVoice: Bool {
        bodyModel.dialogueIsInFront && scenePhase == .active
            && replyModeRawValue == ShannonBodyReplyMode.voice.rawValue && reportsTouch && usesLive2D
    }

    private func holdAudience() {
        bodyModel.audienceRule.observe(othersMayBeListening: othersMayBeListening, at: Date())
    }

    private func sceneChanged() {
        bodyModel.sceneIsActive = scenePhase == .active
        // Going to the background is the last sure moment before the app may be ended.
        holdAudience()
        // Back in front: a page the system ended in the background is loaded again ahead of her screen (as at launch).
        guard scenePhase != .active else { return stage.follow(form: usesLive2D ? .live2d : .waterlight, reason: .foreground) }
        bodyModel.stopVoice()
        ShannonSpeechLevelPublisher.shared.end()
    }

    private func refreshDoing() {
        let next = ShannonBodySignals.doing(loopState: loopState, days: memory.autonomy.days, now: clock)
        if next != doing { doing = next }
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

    /// Her mouth follows the played speech only while the Live2D form is the one in use. The stage loads the page ahead
    /// of the screen that will show her, and keeps it between screens (`ShannonLive2DStage+Keep.swift`).
    private func applyForm(reason: ShannonLive2DStagePolicy.Warming = .chosen) {
        stage.follow(form: usesLive2D ? .live2d : .waterlight, reason: reason)
        if usesLive2D, ShannonLive2DStage.isAvailable {
            ShannonSpeechLevelPublisher.shared.setSink { level in ShannonLive2DStage.shared.setMouthLevel(level) }
            pushAll()
        } else {
            ShannonSpeechLevelPublisher.shared.setSink(nil)
            bodyModel.stopVoice()
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
        let callFace = voice.phase != .idle ? voice.callFace : nil
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

/// Everything that can come over Talk's dialogue display. Each one alone hides her figure there, and
/// with it her voice for a touch and the microphone after it. There is no default for any of them: the
/// conversation root must say each one, so a cover cannot be left out of the rule unnoticed.
struct ShannonDialogueCovers: Equatable, Sendable {
    var threadList: Bool
    var settings: Bool
    var callScreen: Bool
    var workTask: Bool
    var fileImporter: Bool
    var photoPicker: Bool
    /// A sheet or the 「取り消す」 confirmation opened from her words (`ShannonTurnCaptureList`).
    var fromWords: Bool
    /// The explanation that comes before the system's camera prompt.
    var cameraExplanation: Bool

    /// Any one of them is up. Read from every field, so a cover added above counts at once.
    var isAny: Bool { Mirror(reflecting: self).children.contains { ($0.value as? Bool) == true } }
}

/// Says that a sheet, picker or confirmation of this view is up over the window, so her figure is
/// not what the owner sees (and a touch line is not spoken) while it is.
private struct ShannonFigureCover: ViewModifier {
    let isUp: Bool
    @State private var id = UUID()
    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?

    func body(content: Content) -> some View {
        content
            .onChange(of: isUp, initial: true) { bodyModel?.setCoverFromView(id, isUp: isUp) }
            .onDisappear { bodyModel?.setCoverFromView(id, isUp: false) }
    }
}

public extension View {
    func shannonCoversFigure(_ isUp: Bool) -> some View {
        modifier(ShannonFigureCover(isUp: isUp))
    }
}
