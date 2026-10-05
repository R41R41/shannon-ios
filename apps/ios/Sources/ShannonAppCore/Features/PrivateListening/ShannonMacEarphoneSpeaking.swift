#if os(macOS)
import SwiftUI
@preconcurrency import AVFoundation

/// Hears the owner's answer on the Mac after a message she said through his earphones. This stays a short
/// exchange of its own and is not the Mac's voice conversation (A16), which the owner starts himself.
///
/// After her line the microphone records for the answer window. If he speaks, what he said is
/// transcribed and answered through the voice conversation's own server path (the one her desktop body
/// uses): a spoken-style reply, stored as a voice turn in the Talk her message is in. Her reply is said
/// through the earphones and the microphone opens again. If he says nothing the recording is deleted
/// unsent, and nothing is stored.
@MainActor
final class ShannonMacAnswerListener: ShannonReachOutListening {
    /// However long he goes on answering, the exchange ends after this many turns; he can go on in the Talk.
    static let maximumTurns = 8

    private let conversationModel: ShannonConversationModel
    private let speaker: any ShannonReachOutSpeaking
    private let stillPrivate: @MainActor () -> Bool

    init(
        conversationModel: ShannonConversationModel, speaker: any ShannonReachOutSpeaking,
        stillPrivate: @escaping @MainActor () -> Bool
    ) {
        self.conversationModel = conversationModel
        self.speaker = speaker
        self.stillPrivate = stillPrivate
    }

    static var microphoneIsPermitted: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

    func listen(for seconds: Int, after message: ShannonPrivateReachOutMessageDTO) async {
        // The microphone is never asked for from here: the permission prompt belongs to the owner's switch in Settings.
        guard Self.microphoneIsPermitted else { return }
        var threadID = message.threadId
        for _ in 0..<Self.maximumTurns {
            // A voice conversation or dictation the owner started holds the microphone: his answer is heard there.
            guard stillPrivate(), !conversationModel.isSending, !(ShannonSpeechArbiter.shared.sessionInUse?() ?? false),
                  let recording = await recordAnswer(window: TimeInterval(seconds)) else { return }
            do {
                let transcript = try await conversationModel.transcribeVoice(recording)
                // His answer belongs to the Talk her message is in, whichever Talk the window shows.
                let response = try await conversationModel.performLiveVoiceDelegationResponse(
                    transcript: transcript, participantMode: .owner, threadID: threadID
                )
                threadID = response.threadId
                let reply = response.reply.trimmingCharacters(in: .whitespacesAndNewlines)
                // She may choose to stay quiet; then there is no turn to store, as in a voice conversation.
                guard response.voicePlan?.shouldRespond != false, !reply.isEmpty else { return }
                try await conversationModel.commitRealtimeVoiceTurn(
                    userTranscript: transcript, shannonTranscript: reply, threadID: threadID,
                    emotion: response.voicePlan?.turnEmotion
                )
                guard stillPrivate() else { return }
                guard await speaker.speak(reply, stillPrivate: stillPrivate) == .spoken else { return }
            } catch {
                return
            }
        }
    }

    /// Records until he has answered and stopped, or the window passed without speech. Silence returns nil
    /// and leaves no file.
    private func recordAnswer(window: TimeInterval) async -> ShannonVoiceRecording? {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-answer-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 24_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        guard let recorder = try? AVAudioRecorder(url: fileURL, settings: settings) else { return nil }
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord(), recorder.record(forDuration: window + ShannonAnswerWindow.maximumExtension + ShannonAnswerDetector.maximumAnswer) else {
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }
        var detector = ShannonAnswerDetector(opensAt: Date(), seconds: window)
        var decision = ShannonAnswerDetector.Decision.waiting
        while decision == .waiting, recorder.isRecording {
            do { try await Task.sleep(for: .milliseconds(50)) } catch { break }
            // The earphones left: the microphone closes and what was recorded is dropped.
            guard stillPrivate() else { break }
            recorder.updateMeters()
            decision = detector.observe(level: recorder.averagePower(forChannel: 0), at: Date())
        }
        let duration = recorder.currentTime
        recorder.stop()
        let byteCount = ((try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size]) as? NSNumber)?.intValue ?? 0
        guard decision == .answered, ShannonVoiceRecordingPolicy.isUsable(duration: duration, byteCount: byteCount) else {
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }
        return ShannonVoiceRecording(fileURL: fileURL, durationMilliseconds: max(1, Int(duration * 1_000)))
    }
}

/// Wires speaking through the earphones into the Mac app.
@MainActor
final class ShannonMacEarphoneController {
    private let speaker: ShannonEarphoneSpeaker
    private let listener: ShannonMacAnswerListener
    private var activity: NSObjectProtocol?

    /// While she may speak, macOS must not nap the app: its report is a heartbeat, and a late one would let it lapse.
    /// The Mac itself may still go to sleep.
    private func keepAwake(_ wanted: Bool) {
        if wanted, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(
                options: .userInitiatedAllowingIdleSystemSleep, reason: "Shannon may speak through the earphones"
            )
        } else if !wanted, let current = activity {
            ProcessInfo.processInfo.endActivity(current)
            activity = nil
        }
    }

    init(listening: ShannonPrivateListeningModel, conversationModel: ShannonConversationModel) {
        let reachOuts = listening.reachOuts
        speaker = ShannonEarphoneSpeaker(
            streamSpeech: { [conversationModel] text, style, provider in
                try await conversationModel.streamSpeech(text, style: style, provider: provider)
            },
            monitor: ShannonSystemAudioRouteMonitor()
        )
        listener = ShannonMacAnswerListener(conversationModel: conversationModel, speaker: speaker) { [weak reachOuts] in
            reachOuts?.stillPrivate() ?? false
        }
        reachOuts.speaker = speaker
        reachOuts.listener = listener
        // She does not speak while a message of his is on its way, into a voice conversation or dictation (A16),
        // or over her own line for a touch.
        reachOuts.isConversationActive = { [conversationModel] in
            let arbiter = ShannonSpeechArbiter.shared
            return conversationModel.isSending || (arbiter.sessionInUse?() ?? false) || arbiter.touchLineHoldsSound
        }
        listening.stateEvaluated = { [weak self, weak listening] in self?.keepAwake(listening?.canBeOffered ?? false) }
        keepAwake(listening.canBeOffered)
    }
}

public extension View {
    /// Lets Shannon say a message she started on her own through the owner's earphones while the Mac app runs.
    func shannonEarphoneSpeaking(conversation: ShannonConversationModel) -> some View {
        modifier(ShannonMacEarphoneSpeaking(conversationModel: conversation))
    }
}

private struct ShannonMacEarphoneSpeaking: ViewModifier {
    let conversationModel: ShannonConversationModel
    @Environment(ShannonPrivateListeningModel.self) private var listening: ShannonPrivateListeningModel?

    func body(content: Content) -> some View {
        content.task {
            guard let listening, !conversationModel.isDesignPreview else { return }
            listening.attachMacSpeaking(conversationModel: conversationModel)
        }
    }
}

extension ShannonPrivateListeningModel {
    /// One controller for the app, whichever window asks first.
    func attachMacSpeaking(conversationModel: ShannonConversationModel) {
        guard platformController == nil else { return }
        platformController = ShannonMacEarphoneController(listening: self, conversationModel: conversationModel)
    }

    /// The Mac asks for the microphone when the owner switches speaking on, so that his answer can be heard.
    /// Speaking works without it; only the answer is then not heard.
    public func requestMicrophoneForAnswers() async {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else { return }
        _ = await AVCaptureDevice.requestAccess(for: .audio)
    }

    public var microphoneIsPermitted: Bool { ShannonMacAnswerListener.microphoneIsPermitted }
}
#endif
