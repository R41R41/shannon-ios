import Foundation
import Observation

public enum ShannonVoicePhase: String, Equatable, Sendable {
    case idle
    case requestingPermission
    case listening
    case ready
    case thinking
    case speaking
    case denied
    case failed

    public var japaneseLabel: String {
        switch self {
        case .idle: "音声で話す"
        case .requestingPermission: "マイクを準備中"
        case .listening: "聞いている…"
        case .ready: "送信できます"
        case .thinking: "考えている…"
        case .speaking: "シャノンが話している"
        case .denied: "マイクを利用できません"
        case .failed: "音声を聞き取れませんでした"
        }
    }

    public var symbolName: String {
        switch self {
        case .idle: "mic"
        case .requestingPermission: "ellipsis"
        case .listening: "waveform"
        case .ready: "arrow.up.circle.fill"
        case .thinking: "sparkles"
        case .speaking: "speaker.wave.2.fill"
        case .denied: "mic.slash"
        case .failed: "exclamationmark.triangle"
        }
    }
}

public enum ShannonVoicePrimaryAction: Equatable, Sendable {
    case start
    case send
    case stopSpeaking
    case none

    public static func action(for phase: ShannonVoicePhase) -> Self {
        switch phase {
        case .idle, .denied, .failed: .start
        case .listening, .ready: .send
        case .speaking: .stopSpeaking
        case .requestingPermission, .thinking: .none
        }
    }
}

public enum ShannonVoiceAudioFormatPolicy {
    public static func isUsable(sampleRate: Double, channelCount: UInt32) -> Bool {
        sampleRate.isFinite && sampleRate > 0 && channelCount > 0
    }
}

#if os(iOS)
@preconcurrency import AVFoundation
@preconcurrency import Speech

@MainActor
@Observable
public final class ShannonVoiceConversationModel: NSObject {
    public private(set) var phase: ShannonVoicePhase = .idle
    public private(set) var transcript = ""
    public private(set) var errorMessage: String?

    // AVAudioEngine can retain a stale input graph after a route change or a
    // previous capture. Build a fresh engine for each user-initiated session.
    private var audioEngine: AVAudioEngine?
    private let synthesizer = AVSpeechSynthesizer()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapIsInstalled = false

    public override init() {
        super.init()
        synthesizer.delegate = self
    }

    public var primaryAction: ShannonVoicePrimaryAction { .action(for: phase) }

    public func startListening() async {
        stopSpeaking()
        stopCapture()
        transcript = ""
        errorMessage = nil
        phase = .requestingPermission

        let microphone = await AVAudioApplication.requestRecordPermission()
        let speech = await requestSpeechAuthorization()
        guard microphone, speech == .authorized else {
            phase = .denied
            errorMessage = "設定でマイクと音声認識を許可すると、音声で話せます。"
            return
        }

        do {
            try beginCapture()
            phase = .listening
        } catch {
            stopCapture()
            phase = .failed
            errorMessage = "マイクを開始できませんでした。もう一度お試しください。"
        }
    }

    public func finishListening() -> String? {
        stopCapture()
        let value = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty {
            phase = .failed
            errorMessage = "言葉を聞き取れませんでした。"
            return nil
        }
        phase = .ready
        return value
    }

    public func beginThinking() {
        stopCapture()
        errorMessage = nil
        phase = .thinking
    }

    public func speak(_ text: String) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            phase = .idle
            return
        }
        stopSpeaking()
        let utterance = AVSpeechUtterance(string: value)
        utterance.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        utterance.rate = 0.48
        utterance.pitchMultiplier = 1.03
        phase = .speaking
        synthesizer.speak(utterance)
    }

    public func stopSpeaking() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        if phase == .speaking { phase = .idle }
    }

    public func cancel() {
        stopCapture()
        stopSpeaking()
        transcript = ""
        errorMessage = nil
        phase = .idle
    }

    public func finishAfterFailedReply() {
        phase = .failed
        errorMessage = "返答を受け取れませんでした。テキストから再送できます。"
    }

    private func beginCapture() throws {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ja-JP")), recognizer.isAvailable else {
            throw VoiceError.recognizerUnavailable
        }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        guard session.isInputAvailable else { throw VoiceError.inputUnavailable }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        recognitionRequest = request

        let engine = AVAudioEngine()
        audioEngine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard ShannonVoiceAudioFormatPolicy.isUsable(
            sampleRate: format.sampleRate,
            channelCount: format.channelCount
        ) else {
            throw VoiceError.invalidInputFormat
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal == true
            let failed = error != nil
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let text { self.transcript = text }
                if final {
                    self.stopCapture()
                    self.phase = self.transcript.isEmpty ? .failed : .ready
                } else if failed {
                    self.stopCapture()
                    if self.transcript.isEmpty {
                        self.phase = .failed
                        self.errorMessage = "音声認識を続けられませんでした。"
                    } else {
                        self.phase = .ready
                    }
                }
            }
        }

        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        tapIsInstalled = true
        engine.prepare()
        try engine.start()
    }

    private func stopCapture() {
        let engine = audioEngine
        audioEngine = nil
        if engine?.isRunning == true { engine?.stop() }
        if tapIsInstalled, let engine {
            engine.inputNode.removeTap(onBus: 0)
            tapIsInstalled = false
        }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status) }
        }
    }

    private enum VoiceError: Error {
        case recognizerUnavailable
        case inputUnavailable
        case invalidInputFormat
    }
}

extension ShannonVoiceConversationModel: AVSpeechSynthesizerDelegate {
    nonisolated public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard self?.phase == .speaking else { return }
            self?.phase = .idle
        }
    }

    nonisolated public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard self?.phase == .speaking else { return }
            self?.phase = .idle
        }
    }
}
#else
@MainActor
@Observable
public final class ShannonVoiceConversationModel {
    public private(set) var phase: ShannonVoicePhase = .denied
    public private(set) var transcript = ""
    public private(set) var errorMessage: String? = "音声会話はiPhoneで利用できます。"
    public init() {}
    public var primaryAction: ShannonVoicePrimaryAction { .none }
    public func startListening() async {}
    public func finishListening() -> String? { nil }
    public func beginThinking() {}
    public func speak(_ text: String) {}
    public func stopSpeaking() {}
    public func cancel() { phase = .denied }
    public func finishAfterFailedReply() {}
}
#endif
