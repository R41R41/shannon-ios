import Foundation
import Observation

public enum ShannonVoicePhase: String, Equatable, Sendable {
    case idle
    case requestingPermission
    case listening
    case ready
    case transcribing
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
        case .transcribing: "聞き取っています…"
        case .thinking: "考えている…"
        case .speaking: "シャノンが話している"
        case .denied: "マイクを利用できません"
        case .failed: "音声を聞き取れませんでした"
        }
    }

    public var symbolName: String {
        switch self {
        case .idle: "mic"
        case .requestingPermission, .transcribing: "ellipsis"
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
        case .requestingPermission, .transcribing, .thinking: .none
        }
    }
}

public enum ShannonVoiceUsageDescriptionPolicy {
    public static func isPresent(_ value: Any?) -> Bool {
        guard let text = value as? String else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public struct ShannonVoiceRecording: Equatable, Sendable {
    public let fileURL: URL
    public let mimeType: String
    public let durationMilliseconds: Int

    public init(fileURL: URL, mimeType: String = "audio/mp4", durationMilliseconds: Int) {
        self.fileURL = fileURL
        self.mimeType = mimeType
        self.durationMilliseconds = durationMilliseconds
    }
}

public struct ShannonVoiceTranscriptionDTO: Codable, Equatable, Sendable {
    public let transcript: String
    public let model: String
    public let durationSeconds: Double
    public let estimatedCostUsd: Double
}

public struct ShannonGeminiSpeech: Equatable, Sendable {
    public let audio: Data
    public let model: String
    public let voice: String
    public let durationSeconds: Double
    public let estimatedCostUsd: Double

    public init(
        audio: Data,
        model: String,
        voice: String,
        durationSeconds: Double,
        estimatedCostUsd: Double
    ) {
        self.audio = audio
        self.model = model
        self.voice = voice
        self.durationSeconds = durationSeconds
        self.estimatedCostUsd = estimatedCostUsd
    }
}

public struct ShannonGeminiSpeechStream: Sendable {
    public let model: String
    public let voice: String
    public let sampleRate: Int
    public let channels: Int
    public let bitsPerSample: Int
    public let outputUsdPerTenSeconds: Double
    public let costEstimateAvailable: Bool
    public let requestStartedAtUptime: TimeInterval?
    public let chunks: AsyncThrowingStream<Data, Error>

    public init(
        model: String,
        voice: String,
        sampleRate: Int = 24_000,
        channels: Int = 1,
        bitsPerSample: Int = 16,
        outputUsdPerTenSeconds: Double,
        costEstimateAvailable: Bool = true,
        requestStartedAtUptime: TimeInterval? = nil,
        chunks: AsyncThrowingStream<Data, Error>
    ) {
        self.model = model
        self.voice = voice
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitsPerSample = bitsPerSample
        self.outputUsdPerTenSeconds = outputUsdPerTenSeconds
        self.costEstimateAvailable = costEstimateAvailable
        self.requestStartedAtUptime = requestStartedAtUptime
        self.chunks = chunks
    }
}

public enum ShannonVoiceRecordingPolicy {
    public static let maximumDuration: TimeInterval = 60
    public static let maximumBytes = 5 * 1_024 * 1_024
    public static let minimumDuration: TimeInterval = 0.20

    public static func isUsable(duration: TimeInterval, byteCount: Int) -> Bool {
        duration.isFinite
            && duration >= minimumDuration
            && duration <= maximumDuration + 0.5
            && byteCount > 0
            && byteCount <= maximumBytes
    }
}

@preconcurrency import AVFoundation

@MainActor
@Observable
public final class ShannonVoiceConversationModel: NSObject {
    public internal(set) var phase: ShannonVoicePhase = .idle
    public private(set) var transcript = ""
    public private(set) var recordingDuration: TimeInterval = 0
    public private(set) var errorMessage: String?

    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var meteringTask: Task<Void, Never>?
    private var diagnosticSessionID: String?
    private let diagnostics: ShannonVoiceDiagnostics
    /// Only a session this model activated is deactivated by it; a running voice conversation keeps its own.
    private let audioLease = ShannonVoiceAudioSessionLease()

    public override convenience init() {
        self.init(diagnostics: .shared)
    }

    init(diagnostics: ShannonVoiceDiagnostics) {
        self.diagnostics = diagnostics
        super.init()
        synthesizer.delegate = self
    }

    public var primaryAction: ShannonVoicePrimaryAction { .action(for: phase) }

    public func startListening() async {
        stopSpeaking()
        stopCapture(reason: "prepare_new_session", deletingFile: true)
        let sessionID = UUID().uuidString
        diagnosticSessionID = sessionID
        diagnostics.record("voice.start.requested", sessionID: sessionID)
        transcript = ""
        recordingDuration = 0
        errorMessage = nil
        phase = .requestingPermission

        let usagePresent = ShannonVoiceUsageDescriptionPolicy.isPresent(
            Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription")
        )
        diagnostics.record(
            "permission.declarations",
            sessionID: sessionID,
            metadata: ["microphone": String(usagePresent), "speech": "not_required"]
        )
        guard usagePresent else {
            fail("音声機能の設定が不足しています。アプリを更新してください。", step: "voice.start.missing_microphone_declaration")
            return
        }

        diagnostics.record("permission.microphone.before", sessionID: sessionID)
        let permitted = await ShannonMediaPermission.requestMicrophone()
        diagnostics.record(
            "permission.microphone.after",
            sessionID: sessionID,
            metadata: ["granted": String(permitted)]
        )
        guard permitted else {
            phase = .denied
            errorMessage = "設定でマイクを許可すると、音声で話せます。"
            diagnostics.record("voice.start.microphone_denied", sessionID: sessionID)
            return
        }

        do {
            try beginFileRecording(sessionID: sessionID)
            phase = .listening
            diagnostics.record("voice.start.listening", sessionID: sessionID, metadata: ["transport": "m4a_file"])
        } catch {
            let failure = error as NSError
            diagnostics.record(
                "voice.start.failed",
                sessionID: sessionID,
                metadata: ["domain": failure.domain, "code": String(failure.code)]
            )
            stopCapture(reason: "start_error", deletingFile: true)
            phase = .failed
            errorMessage = "マイクを開始できませんでした。もう一度お試しください。"
        }
    }

    public func finishListening() -> ShannonVoiceRecording? {
        guard let recorder, let fileURL = recordingURL else {
            fail("録音を完了できませんでした。", step: "voice.finish.missing_recording")
            return nil
        }
        let duration = max(recordingDuration, recorder.currentTime)
        phase = .transcribing
        recorder.stop()
        self.recorder = nil
        recordingURL = nil
        stopMetering()
        audioLease.release()

        let byteCount = ((try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size]) as? NSNumber)?.intValue ?? 0
        diagnostics.record(
            "voice.recording.finished",
            sessionID: diagnosticSessionID,
            metadata: [
                "duration_ms": String(Int(duration * 1_000)),
                "bytes": String(byteCount),
            ]
        )
        diagnosticSessionID = nil
        guard ShannonVoiceRecordingPolicy.isUsable(duration: duration, byteCount: byteCount) else {
            try? FileManager.default.removeItem(at: fileURL)
            phase = .failed
            errorMessage = duration < ShannonVoiceRecordingPolicy.minimumDuration
                ? "もう少し長く話してから送ってください。"
                : "録音が長すぎるため送信できませんでした。"
            return nil
        }
        return ShannonVoiceRecording(
            fileURL: fileURL,
            durationMilliseconds: max(1, Int(duration * 1_000))
        )
    }

    public func acceptTranscript(_ value: String) {
        transcript = value
        errorMessage = nil
        phase = .thinking
    }

    public func finishAfterFailedTranscription() {
        phase = .failed
        errorMessage = "音声を文字にできませんでした。録り直すか、テキストで入力してください。"
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

    public func speakGemini(_ speech: ShannonGeminiSpeech) throws {
        guard !speech.audio.isEmpty else { throw PlaybackError.invalidAudio }
        stopSpeaking()
#if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
#endif
        try audioLease.activate()
        let player = try AVAudioPlayer(data: speech.audio)
        player.delegate = self
        guard player.prepareToPlay(), player.play() else { throw PlaybackError.startFailed }
        audioPlayer = player
        phase = .speaking
    }

    public func stopSpeaking() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        if audioPlayer?.isPlaying == true { audioPlayer?.stop() }
        audioPlayer = nil
        audioLease.release()
        if phase == .speaking { phase = .idle }
    }

    public func cancel() {
        stopCapture(reason: "cancelled", deletingFile: true)
        stopSpeaking()
        transcript = ""
        recordingDuration = 0
        errorMessage = nil
        phase = .idle
    }

    public func finishAfterFailedReply() {
        phase = .failed
        errorMessage = "返答を受け取れませんでした。テキストから再送できます。"
    }

    public func finishAfterFailedGeminiSpeech() {
        phase = .failed
        errorMessage = "Gemini音声を生成または再生できませんでした。返答はトークに保存されています。"
    }

    private func beginFileRecording(sessionID: String) throws {
#if os(iOS)
        let session = AVAudioSession.sharedInstance()
        diagnostics.record("capture.session.category.before", sessionID: sessionID)
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        diagnostics.record("capture.session.category.after", sessionID: sessionID)
        diagnostics.record("capture.session.activate.before", sessionID: sessionID)
        try audioLease.activate()
        diagnostics.record(
            "capture.session.activate.after",
            sessionID: sessionID,
            metadata: ["input_available": String(session.isInputAvailable)]
        )
        guard session.isInputAvailable else { throw RecordingError.inputUnavailable }
#else
        // The Mac records from the system's input; there is no session to prepare.
        guard AVCaptureDevice.default(for: .audio) != nil else { throw RecordingError.inputUnavailable }
        try audioLease.activate()
#endif

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-voice-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 24_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        diagnostics.record("capture.recorder.create.before", sessionID: sessionID)
        let recorder = try AVAudioRecorder(url: fileURL, settings: settings)
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord() else { throw RecordingError.preparationFailed }
        diagnostics.record("capture.recorder.create.after", sessionID: sessionID)
        guard recorder.record(forDuration: ShannonVoiceRecordingPolicy.maximumDuration) else {
            throw RecordingError.startFailed
        }
        self.recorder = recorder
        recordingURL = fileURL
        startMetering(recorder)
        diagnostics.record("capture.recorder.started", sessionID: sessionID)
    }

    private func startMetering(_ recorder: AVAudioRecorder) {
        meteringTask?.cancel()
        meteringTask = Task { [weak self, weak recorder] in
            while !Task.isCancelled, let recorder, recorder.isRecording {
                self?.recordingDuration = min(recorder.currentTime, ShannonVoiceRecordingPolicy.maximumDuration)
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func stopMetering() {
        meteringTask?.cancel()
        meteringTask = nil
    }

    private func stopCapture(reason: String, deletingFile: Bool) {
        diagnostics.record("capture.stop.before", sessionID: diagnosticSessionID, metadata: ["reason": reason])
        recorder?.stop()
        recorder = nil
        stopMetering()
        if deletingFile, let recordingURL {
            try? FileManager.default.removeItem(at: recordingURL)
        }
        recordingURL = nil
        audioLease.release()
        diagnostics.record("capture.stop.after", sessionID: diagnosticSessionID, metadata: ["reason": reason])
        diagnosticSessionID = nil
    }

    private func fail(_ message: String, step: String) {
        diagnostics.record(step, sessionID: diagnosticSessionID)
        stopCapture(reason: "failed", deletingFile: true)
        phase = .failed
        errorMessage = message
    }

    private enum RecordingError: Error {
        case inputUnavailable
        case preparationFailed
        case startFailed
    }

    private enum PlaybackError: Error {
        case invalidAudio
        case startFailed
    }
}

extension ShannonVoiceConversationModel: AVAudioRecorderDelegate, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    nonisolated public func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, self.phase == .listening else { return }
            self.recordingDuration = min(recorder.currentTime, ShannonVoiceRecordingPolicy.maximumDuration)
            self.stopMetering()
            self.phase = flag ? .ready : .failed
            if !flag { self.errorMessage = "録音を完了できませんでした。" }
            self.diagnostics.record(
                flag ? "voice.recording.maximum_duration" : "voice.recording.failed",
                sessionID: self.diagnosticSessionID
            )
        }
    }

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

    nonisolated public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard self?.audioPlayer === player else { return }
            self?.audioPlayer = nil
            self?.audioLease.release()
            self?.phase = flag ? .idle : .failed
            if !flag { self?.errorMessage = "Gemini音声を最後まで再生できませんでした。" }
        }
    }
}
