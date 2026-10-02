#if os(iOS)
import Observation
import SwiftUI
import UIKit

/// Hears the owner's answer on the iPhone: the ordinary voice conversation, started on the Talk her
/// message is in, and ended again if he says nothing.
@MainActor
final class ShannonPhoneAnswerListener: ShannonReachOutListening {
    private let conversationModel: ShannonConversationModel
    private let geminiVoiceModel: ShannonGeminiLiveSessionModel
    private let workspace: ShannonVoiceWorkspaceState
    private let stillPrivate: @MainActor () -> Bool

    init(
        conversationModel: ShannonConversationModel, geminiVoiceModel: ShannonGeminiLiveSessionModel,
        workspace: ShannonVoiceWorkspaceState, stillPrivate: @escaping @MainActor () -> Bool
    ) {
        self.conversationModel = conversationModel
        self.geminiVoiceModel = geminiVoiceModel
        self.workspace = workspace
        self.stillPrivate = stillPrivate
    }

    func listen(for seconds: Int, after message: ShannonPrivateReachOutMessageDTO) async {
        // The microphone is never asked for from here: a permission prompt belongs to a tap of the owner's.
        // A call that failed earlier and was left on screen holds nothing; a call in any other state is a conversation.
        guard ShannonMediaPermission.currentMicrophone() == .granted,
              geminiVoiceModel.phase == .idle || geminiVoiceModel.phase == .failed else { return }
        let provider = UserDefaults.standard.string(forKey: ShannonSpeechProvider.storageKey)
            .flatMap(ShannonSpeechProvider.init(rawValue:)) ?? .gemini
        // The card of the last call's 「友人も一緒」 periods is put back if this call comes to nothing.
        let callMemory = workspace.callMemory
        let starting = workspace.beginCall(
            mode: .owner, speechProvider: provider, threadID: message.threadId,
            conversationModel: conversationModel, geminiVoiceModel: geminiVoiceModel
        )
        let request = workspace.connectionRequestID
        // The call is started by a task of its own; the window is watched only once that has run.
        await starting.value
        let wait = await geminiVoiceModel.awaitAnswer(seconds: seconds, stillPrivate: stillPrivate)
        ShannonVoiceDiagnostics.shared.record("reach_out.listen.finished", metadata: ["result": String(describing: wait)])
        // He answered: it is an ordinary voice conversation now, stored and ended as one.
        // Anything else: nothing was said, the call could not start (iOS may refuse the microphone in the background),
        // or its sound would no longer be only his. It ends without a trace and without the failed-call screen, unless
        // he started another call meanwhile.
        guard wait != .answered, workspace.connectionRequestID == request else { return }
        workspace.endCall(geminiVoiceModel)
        if workspace.callMemory == nil { workspace.callMemory = callMemory }
    }
}

/// Speaking through the earphones on the iPhone: her voice, the microphone for the answer, and the
/// standby that lets the app do both while another app is in front. It follows the listening model and
/// the voice conversation directly, not through a view, so it also works while no view is drawn.
@MainActor
final class ShannonPhoneEarphoneController {
    private let listening: ShannonPrivateListeningModel
    private let conversationModel: ShannonConversationModel
    private let geminiVoiceModel: ShannonGeminiLiveSessionModel
    private let dictation: ShannonVoiceConversationModel
    private let standby = ShannonStandbyAudio()
    private let speaker: ShannonEarphoneSpeaker
    private let listener: ShannonPhoneAnswerListener
    private var powerObserver: NSObjectProtocol?

    init(
        listening: ShannonPrivateListeningModel, conversationModel: ShannonConversationModel,
        geminiVoiceModel: ShannonGeminiLiveSessionModel, workspace: ShannonVoiceWorkspaceState,
        dictation: ShannonVoiceConversationModel
    ) {
        self.listening = listening
        self.conversationModel = conversationModel
        self.geminiVoiceModel = geminiVoiceModel
        self.dictation = dictation
        speaker = ShannonEarphoneSpeaker(
            streamSpeech: { [conversationModel] text, style, provider in
                try await conversationModel.streamSpeech(text, style: style, provider: provider)
            },
            monitor: ShannonSystemAudioRouteMonitor()
        )
        listener = ShannonPhoneAnswerListener(
            conversationModel: conversationModel, geminiVoiceModel: geminiVoiceModel, workspace: workspace,
            stillPrivate: { [weak listening] in
                guard let listening, listening.speaksEnabled else { return false }
                return listening.refreshRoute()
            }
        )
        speaker.beginSession = { [standby] in try standby.beginSpeech() }
        speaker.endSession = { [standby] in standby.endSpeech() }
        standby.stateChanged = { [weak listening, standby] state in
            listening?.standbyState = state
            listening?.isStandingBy = standby.keepsAppRunning
        }
        let reachOuts = listening.reachOuts
        reachOuts.speaker = speaker
        reachOuts.listener = listener
        // She does not speak into a conversation: a voice call, dictation, or a message on its way.
        reachOuts.isConversationActive = { [weak self] in self?.conversationIsActive ?? true }
        // Between her line and the microphone no audio runs for a moment; this keeps iOS from suspending the app there.
        reachOuts.protect = { work in
            let assertion = ShannonBackgroundAssertion(name: "shannon.reach-out")
            await work()
            assertion.end()
        }
        listening.stateEvaluated = { [weak self] in self?.updateStandby() }
        // Low Power Mode: the owner asked the phone to save battery, so the app does not stand by.
        listening.isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        powerObserver = NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak listening] _ in
            Task { @MainActor [weak listening] in
                listening?.isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
        }
        followSessionUse()
        updateStandby()
    }

    /// A voice conversation, dictation or the reply player holds the audio session. A call that failed holds nothing.
    private var sessionInUse: Bool {
        (geminiVoiceModel.phase != .idle && geminiVoiceModel.phase != .failed) || Self.busyDictationPhases.contains(dictation.phase)
    }

    private static let busyDictationPhases: Set<ShannonVoicePhase> = [.requestingPermission, .listening, .ready, .transcribing, .speaking]

    private var conversationIsActive: Bool { sessionInUse || conversationModel.isSending }

    func updateStandby() {
        standby.update(wanted: listening.wantsStandby, sessionInUse: sessionInUse, readsRoute: listening.speaksEnabled)
    }

    /// The owner opened the app: a standby iOS had stopped starts again.
    func appBecameActive() {
        standby.restartIfStopped()
    }

    /// Standby steps aside while a call or dictation uses the audio, and takes over again when it ends.
    private func followSessionUse() {
        withObservationTracking {
            _ = sessionInUse
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.updateStandby()
                self?.followSessionUse()
            }
        }
    }
}

/// Holds a little background running time, and gives it back at the end or when iOS says time is up.
@MainActor
final class ShannonBackgroundAssertion {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    init(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            Task { @MainActor [weak self] in self?.end() }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

extension ShannonPrivateListeningModel {
    /// Whether the answer after her line can be heard. The iPhone asks for the microphone at the first voice conversation.
    public var microphoneIsPermitted: Bool { ShannonMediaPermission.currentMicrophone() == .granted }
}

/// Wires speaking through the earphones into the iPhone app.
struct ShannonPhoneEarphoneSpeaking: ViewModifier {
    let conversationModel: ShannonConversationModel
    let geminiVoiceModel: ShannonGeminiLiveSessionModel
    let workspace: ShannonVoiceWorkspaceState
    let dictation: ShannonVoiceConversationModel
    @Environment(ShannonPrivateListeningModel.self) private var listening: ShannonPrivateListeningModel?
    @Environment(\.scenePhase) private var scenePhase
    @State private var controller: ShannonPhoneEarphoneController?

    func body(content: Content) -> some View {
        content
            .task {
                guard let listening, controller == nil, !conversationModel.isDesignPreview else { return }
                controller = ShannonPhoneEarphoneController(
                    listening: listening, conversationModel: conversationModel,
                    geminiVoiceModel: geminiVoiceModel, workspace: workspace, dictation: dictation
                )
            }
            .onChange(of: scenePhase) {
                if scenePhase == .active { controller?.appBecameActive() }
            }
    }
}
#endif
