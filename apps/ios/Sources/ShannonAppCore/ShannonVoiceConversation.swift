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

public enum ShannonSpeechPermissionState: Equatable, Sendable {
    case notDetermined
    case denied
    case restricted
    case authorized
}

public enum ShannonLegacySpeechAuthorizationAction: Equatable, Sendable {
    case request
    case proceed
    case deny

    public static func action(for state: ShannonSpeechPermissionState) -> Self {
        switch state {
        case .notDetermined: .request
        case .authorized: .proceed
        case .denied, .restricted: .deny
        }
    }
}

public enum ShannonVoiceUsageDescriptionPolicy {
    public static func isPresent(_ value: Any?) -> Bool {
        guard let text = value as? String else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
    private var analyzerCapture: AnyObject?
    private var diagnosticSessionID: String?
    private let diagnostics: ShannonVoiceDiagnostics

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
        stopCapture(reason: "prepare_new_session")
        let sessionID = UUID().uuidString
        diagnosticSessionID = sessionID
        diagnostics.record("voice.start.requested", sessionID: sessionID)
        transcript = ""
        errorMessage = nil
        phase = .requestingPermission

        let microphoneUsagePresent = ShannonVoiceUsageDescriptionPolicy.isPresent(
            Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription")
        )
        let speechUsagePresent = ShannonVoiceUsageDescriptionPolicy.isPresent(
            Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription")
        )
        diagnostics.record(
            "permission.declarations",
            sessionID: sessionID,
            metadata: [
                "microphone": String(microphoneUsagePresent),
                "speech": String(speechUsagePresent),
            ]
        )
        guard microphoneUsagePresent else {
            phase = .failed
            errorMessage = "音声機能の設定が不足しています。アプリを更新してください。"
            diagnostics.record("voice.start.missing_microphone_declaration", sessionID: sessionID)
            return
        }

        diagnostics.record("permission.microphone.before", sessionID: sessionID)
        let microphone = await AVAudioApplication.requestRecordPermission()
        diagnostics.record(
            "permission.microphone.after",
            sessionID: sessionID,
            metadata: ["granted": String(microphone)]
        )
        guard microphone else {
            phase = .denied
            errorMessage = "設定でマイクを許可すると、音声で話せます。"
            diagnostics.record("voice.start.microphone_denied", sessionID: sessionID)
            return
        }

        do {
            if #available(iOS 26.0, *) {
                diagnostics.record("capture.engine.selected", sessionID: sessionID, metadata: ["engine": "SpeechAnalyzer"])
                let capture = ShannonSpeechAnalyzerCapture(diagnostics: diagnostics)
                analyzerCapture = capture
                try await capture.start(
                    sessionID: sessionID,
                    transcriptUpdated: { [weak self] value in
                        self?.transcript = value
                    },
                    failed: { [weak self] in
                        guard let self else { return }
                        self.stopCapture(reason: "analyzer_error")
                        if self.transcript.isEmpty {
                            self.phase = .failed
                            self.errorMessage = "音声認識を続けられませんでした。"
                        } else {
                            self.phase = .ready
                        }
                    }
                )
            } else {
                guard speechUsagePresent else {
                    throw VoiceError.missingSpeechUsageDescription
                }
                let speech = await resolveLegacySpeechAuthorization(sessionID: sessionID)
                guard speech == .authorized else {
                    phase = .denied
                    errorMessage = "設定で音声認識を許可すると、音声で話せます。"
                    diagnostics.record("voice.start.speech_denied", sessionID: sessionID)
                    return
                }
                diagnostics.record("capture.engine.selected", sessionID: sessionID, metadata: ["engine": "SFSpeechRecognizer"])
                try beginLegacyCapture(sessionID: sessionID)
            }
            phase = .listening
            diagnostics.record("voice.start.listening", sessionID: sessionID)
        } catch {
            let failure = error as NSError
            diagnostics.record(
                "voice.start.failed",
                sessionID: sessionID,
                metadata: ["domain": failure.domain, "code": String(failure.code)]
            )
            stopCapture(reason: "start_error")
            phase = .failed
            errorMessage = "マイクを開始できませんでした。もう一度お試しください。"
        }
    }

    public func finishListening() -> String? {
        stopCapture(reason: "user_finished")
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
        stopCapture(reason: "begin_thinking")
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
        stopCapture(reason: "cancelled")
        stopSpeaking()
        transcript = ""
        errorMessage = nil
        phase = .idle
    }

    public func finishAfterFailedReply() {
        phase = .failed
        errorMessage = "返答を受け取れませんでした。テキストから再送できます。"
    }

    private func beginLegacyCapture(sessionID: String) throws {
        diagnostics.record("capture.recognizer.before", sessionID: sessionID)
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ja-JP")), recognizer.isAvailable else {
            throw VoiceError.recognizerUnavailable
        }
        diagnostics.record(
            "capture.recognizer.after",
            sessionID: sessionID,
            metadata: [
                "available": String(recognizer.isAvailable),
                "on_device": String(recognizer.supportsOnDeviceRecognition),
            ]
        )

        let session = AVAudioSession.sharedInstance()
        diagnostics.record("capture.session.category.before", sessionID: sessionID)
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        diagnostics.record("capture.session.category.after", sessionID: sessionID)
        diagnostics.record("capture.session.activate.before", sessionID: sessionID)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        diagnostics.record(
            "capture.session.activate.after",
            sessionID: sessionID,
            metadata: [
                "input_available": String(session.isInputAvailable),
                "sample_rate": String(session.sampleRate),
                "input_channels": String(session.inputNumberOfChannels),
                "route_inputs": session.currentRoute.inputs.map(\.portType.rawValue).joined(separator: ","),
            ]
        )
        guard session.isInputAvailable else { throw VoiceError.inputUnavailable }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        recognitionRequest = request

        let engine = AVAudioEngine()
        audioEngine = engine
        diagnostics.record("capture.input_node.before", sessionID: sessionID)
        let input = engine.inputNode
        diagnostics.record("capture.input_node.after", sessionID: sessionID)
        diagnostics.record("capture.format.before", sessionID: sessionID)
        let format = input.outputFormat(forBus: 0)
        diagnostics.record(
            "capture.format.after",
            sessionID: sessionID,
            metadata: [
                "sample_rate": String(format.sampleRate),
                "channels": String(format.channelCount),
                "interleaved": String(format.isInterleaved),
                "common_format": String(format.commonFormat.rawValue),
            ]
        )
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
                    self.stopCapture(reason: "recognition_final")
                    self.phase = self.transcript.isEmpty ? .failed : .ready
                } else if failed {
                    self.stopCapture(reason: "recognition_error")
                    if self.transcript.isEmpty {
                        self.phase = .failed
                        self.errorMessage = "音声認識を続けられませんでした。"
                    } else {
                        self.phase = .ready
                    }
                }
            }
        }

        diagnostics.record("capture.tap.before", sessionID: sessionID)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        tapIsInstalled = true
        diagnostics.record("capture.tap.after", sessionID: sessionID)
        diagnostics.record("capture.prepare.before", sessionID: sessionID)
        engine.prepare()
        diagnostics.record("capture.prepare.after", sessionID: sessionID)
        diagnostics.record("capture.engine_start.before", sessionID: sessionID)
        try engine.start()
        diagnostics.record("capture.engine_start.after", sessionID: sessionID)
    }

    private func stopCapture(reason: String) {
        let sessionID = diagnosticSessionID
        diagnostics.record("capture.stop.before", sessionID: sessionID, metadata: ["reason": reason])
        if #available(iOS 26.0, *), let capture = analyzerCapture as? ShannonSpeechAnalyzerCapture {
            capture.stop(sessionID: sessionID, reason: reason)
        }
        analyzerCapture = nil
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
        diagnostics.record("capture.stop.after", sessionID: sessionID, metadata: ["reason": reason])
        diagnosticSessionID = nil
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status) }
        }
    }

    private func resolveLegacySpeechAuthorization(sessionID: String) async -> SFSpeechRecognizerAuthorizationStatus {
        diagnostics.record("permission.speech.status.before", sessionID: sessionID)
        let current = SFSpeechRecognizer.authorizationStatus()
        diagnostics.record(
            "permission.speech.status.after",
            sessionID: sessionID,
            metadata: ["status": String(current.rawValue)]
        )
        switch ShannonLegacySpeechAuthorizationAction.action(for: current.shannonPermissionState) {
        case .proceed, .deny:
            return current
        case .request:
            diagnostics.record("permission.speech.request.before", sessionID: sessionID)
            let requested = await requestSpeechAuthorization()
            diagnostics.record(
                "permission.speech.request.after",
                sessionID: sessionID,
                metadata: ["status": String(requested.rawValue)]
            )
            return requested
        }
    }

    private enum VoiceError: Error {
        case recognizerUnavailable
        case inputUnavailable
        case invalidInputFormat
        case missingSpeechUsageDescription
    }
}

private extension SFSpeechRecognizerAuthorizationStatus {
    var shannonPermissionState: ShannonSpeechPermissionState {
        switch self {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .restricted: .restricted
        case .authorized: .authorized
        @unknown default: .denied
        }
    }
}

@available(iOS 26.0, *)
@MainActor
private final class ShannonSpeechAnalyzerCapture {
    private let diagnostics: ShannonVoiceDiagnostics
    private let audioEngine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var rawAudioBuilder: AsyncStream<ShannonVoiceAudioBuffer>.Continuation?
    private var audioInputTask: Task<Void, Never>?
    private var resultsTask: Task<Void, Never>?
    private var tapIsInstalled = false

    init(diagnostics: ShannonVoiceDiagnostics) {
        self.diagnostics = diagnostics
    }

    func start(
        sessionID: String,
        transcriptUpdated: @escaping @MainActor (String) -> Void,
        failed: @escaping @MainActor () -> Void
    ) async throws {
        diagnostics.record("analyzer.locale.before", sessionID: sessionID)
        guard let locale = await SpeechTranscriber.supportedLocale(
            equivalentTo: Locale(identifier: "ja-JP")
        ) else {
            throw AnalyzerError.localeUnavailable
        }
        diagnostics.record("analyzer.locale.after", sessionID: sessionID, metadata: ["supported": "true"])

        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        diagnostics.record("analyzer.assets.before", sessionID: sessionID)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            diagnostics.record("analyzer.assets.download.before", sessionID: sessionID)
            try await request.downloadAndInstall()
            diagnostics.record("analyzer.assets.download.after", sessionID: sessionID)
        }
        diagnostics.record("analyzer.assets.after", sessionID: sessionID)

        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber]
        ) else {
            throw AnalyzerError.formatUnavailable
        }
        diagnostics.record(
            "analyzer.format.ready",
            sessionID: sessionID,
            metadata: [
                "sample_rate": String(analyzerFormat.sampleRate),
                "channels": String(analyzerFormat.channelCount),
            ]
        )

        let (inputSequence, builder) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = builder
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer

        resultsTask = Task { [weak self] in
            var finalized = ""
            var recordedFirstResult = false
            do {
                for try await result in transcriber.results {
                    guard !Task.isCancelled else { return }
                    if !recordedFirstResult {
                        recordedFirstResult = true
                        self?.diagnostics.record("analyzer.results.first", sessionID: sessionID)
                    }
                    let value = String(result.text.characters)
                    if result.isFinal {
                        finalized += value
                        transcriptUpdated(finalized)
                    } else {
                        transcriptUpdated(finalized + value)
                    }
                }
            } catch {
                let failure = error as NSError
                self?.diagnostics.record(
                    "analyzer.results.failed",
                    sessionID: sessionID,
                    metadata: ["domain": failure.domain, "code": String(failure.code)]
                )
                failed()
            }
        }

        diagnostics.record("analyzer.start.before", sessionID: sessionID)
        try await analyzer.start(inputSequence: inputSequence)
        diagnostics.record("analyzer.start.after", sessionID: sessionID)

        let audioSession = AVAudioSession.sharedInstance()
        diagnostics.record("capture.session.category.before", sessionID: sessionID)
        try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
        diagnostics.record("capture.session.category.after", sessionID: sessionID)
        diagnostics.record("capture.session.activate.before", sessionID: sessionID)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        diagnostics.record("capture.session.activate.after", sessionID: sessionID)
        guard audioSession.isInputAvailable else { throw AnalyzerError.inputUnavailable }

        let input = audioEngine.inputNode
        let sourceFormat = input.outputFormat(forBus: 0)
        guard ShannonVoiceAudioFormatPolicy.isUsable(
            sampleRate: sourceFormat.sampleRate,
            channelCount: sourceFormat.channelCount
        ) else {
            throw AnalyzerError.formatUnavailable
        }

        // AVAudioEngine invokes its tap on a real-time audio thread. Keep that
        // callback limited to queueing the native buffer, matching Apple's
        // SpeechAnalyzer sample. Conversion, allocation, diagnostics, and
        // AnalyzerInput construction run on a separate task instead.
        let (rawAudioSequence, rawAudioBuilder) = AsyncStream<ShannonVoiceAudioBuffer>.makeStream()
        self.rawAudioBuilder = rawAudioBuilder
        let converter = ShannonVoiceBufferConverter(outputFormat: analyzerFormat)
        let diagnostics = diagnostics
        audioInputTask = Task.detached(priority: .userInitiated) {
            defer { builder.finish() }
            var recordedFirstBuffer = false
            var recordedFirstOutput = false
            for await input in rawAudioSequence {
                guard !Task.isCancelled else { return }
                if !recordedFirstBuffer {
                    recordedFirstBuffer = true
                    diagnostics.record("analyzer.audio.first_buffer", sessionID: sessionID)
                }
                do {
                    let converted = try converter.convert(input.buffer)
                    builder.yield(AnalyzerInput(buffer: converted))
                    if !recordedFirstOutput {
                        recordedFirstOutput = true
                        diagnostics.record("analyzer.convert.first_output", sessionID: sessionID)
                    }
                } catch {
                    let failure = error as NSError
                    diagnostics.record(
                        "analyzer.convert.failed",
                        sessionID: sessionID,
                        metadata: ["domain": failure.domain, "code": String(failure.code)]
                    )
                }
            }
        }

        diagnostics.record("capture.tap.before", sessionID: sessionID)
        input.installTap(onBus: 0, bufferSize: 4_096, format: sourceFormat) { buffer, _ in
            rawAudioBuilder.yield(ShannonVoiceAudioBuffer(buffer: buffer))
        }
        tapIsInstalled = true
        diagnostics.record("capture.tap.after", sessionID: sessionID)
        diagnostics.record("capture.prepare.before", sessionID: sessionID)
        audioEngine.prepare()
        diagnostics.record("capture.prepare.after", sessionID: sessionID)
        diagnostics.record("capture.engine_start.before", sessionID: sessionID)
        try audioEngine.start()
        diagnostics.record("capture.engine_start.after", sessionID: sessionID)
    }

    func stop(sessionID: String?, reason: String) {
        if audioEngine.isRunning { audioEngine.stop() }
        if tapIsInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapIsInstalled = false
        }
        rawAudioBuilder?.finish()
        rawAudioBuilder = nil
        let audioInputTask = audioInputTask
        self.audioInputTask = nil
        let inputBuilder = inputBuilder
        self.inputBuilder = nil
        if audioInputTask == nil {
            inputBuilder?.finish()
        }
        let analyzer = analyzer
        let resultsTask = resultsTask
        self.analyzer = nil
        self.resultsTask = nil
        Task {
            await audioInputTask?.value
            do {
                try await analyzer?.finalizeAndFinishThroughEndOfInput()
            } catch {
                let failure = error as NSError
                diagnostics.record(
                    "analyzer.finish.failed",
                    sessionID: sessionID,
                    metadata: ["domain": failure.domain, "code": String(failure.code)]
                )
            }
            resultsTask?.cancel()
        }
        diagnostics.record("analyzer.stopped", sessionID: sessionID, metadata: ["reason": reason])
    }

    private enum AnalyzerError: Error {
        case localeUnavailable
        case formatUnavailable
        case inputUnavailable
    }
}

@available(iOS 26.0, *)
private struct ShannonVoiceAudioBuffer: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
}

@available(iOS 26.0, *)
private final class ShannonVoiceBufferConverter: @unchecked Sendable {
    private let outputFormat: AVAudioFormat
    private var converter: AVAudioConverter?

    init(outputFormat: AVAudioFormat) {
        self.outputFormat = outputFormat
    }

    func convert(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let inputFormat = buffer.format
        guard inputFormat != outputFormat else { return buffer }
        if converter == nil || converter?.inputFormat != inputFormat || converter?.outputFormat != outputFormat {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
            converter?.primeMethod = .none
        }
        guard let converter else { throw ConversionError.converterUnavailable }
        let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard let converted = AVAudioPCMBuffer(
            pcmFormat: converter.outputFormat,
            frameCapacity: max(capacity, 1)
        ) else {
            throw ConversionError.bufferUnavailable
        }
        var conversionError: NSError?
        let inputState = ShannonVoiceConversionInputState()
        let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
            defer { inputState.wasUsed = true }
            inputStatus.pointee = inputState.wasUsed ? .noDataNow : .haveData
            return inputState.wasUsed ? nil : buffer
        }
        guard status != .error else {
            throw conversionError ?? ConversionError.conversionFailed
        }
        return converted
    }

    private enum ConversionError: Error {
        case converterUnavailable
        case bufferUnavailable
        case conversionFailed
    }
}

@available(iOS 26.0, *)
private final class ShannonVoiceConversionInputState: @unchecked Sendable {
    var wasUsed = false
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
