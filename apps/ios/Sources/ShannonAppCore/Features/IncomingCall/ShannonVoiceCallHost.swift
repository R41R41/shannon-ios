#if os(iOS)
import Foundation
import Observation
import UIKit
@preconcurrency import AVFoundation

/// The one voice conversation of the iPhone app, kept where it exists whether or not a screen does.
///
/// A call from Shannon can be answered while the app has no window: it was terminated, or the phone is
/// locked. The conversation that follows her line is the ordinary one, so its model and its workspace
/// live here, and the conversation screen uses these same objects when it is there. One model means one
/// owner of the audio session: a call the owner started in the app and a call from her can never both run.
@MainActor
@Observable
public final class ShannonVoiceCallHost {
    public static let shared = ShannonVoiceCallHost()

    @ObservationIgnored let voiceModel = ShannonGeminiLiveSessionModel()
    @ObservationIgnored let workspace = ShannonVoiceWorkspaceState()
    /// Dictation or its reply player holds the audio; set by whoever owns the dictation model.
    @ObservationIgnored var isDictating: @MainActor () -> Bool = { false }
    /// Calls from Shannon; nil until the app set them up at launch.
    public internal(set) var calls: ShannonIncomingCallCoordinator?

    /// A call from her is ringing or going on: the audio session is the system's and the call's.
    public var systemCallIsActive: Bool { calls?.isActive ?? false }
}

/// The ordinary voice conversation, run for a call from Shannon.
@MainActor
final class ShannonCallConversation: ShannonCallConversing {
    private let conversationModel: ShannonConversationModel
    private let host: ShannonVoiceCallHost
    private var request: UUID?
    var ended: (@MainActor () -> Void)?

    init(conversationModel: ShannonConversationModel, host: ShannonVoiceCallHost = .shared) {
        self.conversationModel = conversationModel
        self.host = host
    }

    private var voice: ShannonGeminiLiveSessionModel { host.voiceModel }

    var isBusy: Bool {
        // A call that failed and was left on screen holds nothing.
        (voice.phase != .idle && voice.phase != .failed) || conversationModel.isSending || host.isDictating()
    }

    var canListen: Bool { ShannonMediaPermission.currentMicrophone() == .granted }

    func prepareAudio() {
        // The category only: the system activates the session for an answered call and says so
        // (`provider(_:didActivate:)`). No speaker override: without earphones the phone routes a call to its receiver.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        } catch {
            ShannonVoiceDiagnostics.shared.record("incoming_call.audio.prepare.failed", metadata: ["code": String((error as NSError).code)])
        }
    }

    func start(threadID: String) async -> Bool {
        guard canListen, !isBusy else { return false }
        let provider = UserDefaults.standard.string(forKey: ShannonSpeechProvider.storageKey)
            .flatMap(ShannonSpeechProvider.init(rawValue:)) ?? .gemini
        let starting = host.workspace.beginCall(
            mode: .owner, speechProvider: provider, threadID: threadID,
            conversationModel: conversationModel, geminiVoiceModel: voice
        )
        let request = host.workspace.connectionRequestID
        self.request = request
        await starting.value
        guard host.workspace.connectionRequestID == request, voice.phase != .idle, voice.phase != .failed else {
            finish()
            return false
        }
        // Answered with no screen in front (the lock screen, another app): the conversation ends by itself after
        // the background silence limit, as any conversation in the background does.
        if UIApplication.shared.applicationState != .active { voice.sceneDidEnterBackground() }
        watch(request)
        return true
    }

    func stop() {
        guard let request, host.workspace.connectionRequestID == request else { return }
        self.request = nil
        host.workspace.endCall(voice)
    }

    func setMuted(_ muted: Bool) {
        guard request != nil, voice.isMicrophoneMuted != muted else { return }
        voice.toggleMicrophoneMute()
    }

    /// Follows the conversation until it is over: ended in the app, ended after silence, or failed for good.
    private func watch(_ request: UUID?) {
        withObservationTracking {
            _ = voice.phase
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.request == request else { return }
                if self.voice.phase == .idle || self.voice.phase == .failed {
                    self.finish()
                    self.ended?()
                } else {
                    self.watch(request)
                }
            }
        }
    }

    /// Nothing of a call that is over stays behind: a failed conversation would otherwise keep its failure screen.
    private func finish() {
        let request = self.request
        self.request = nil
        if let request, host.workspace.connectionRequestID == request { host.workspace.endCall(voice) }
    }
}
#endif
