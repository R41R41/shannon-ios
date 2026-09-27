#if os(iOS)
import Foundation
import Observation
@preconcurrency import AVFoundation

public enum ShannonGeminiLivePhase: String, Equatable, Sendable {
    case idle, requestingPermission, connecting, listening, thinking, speaking, reconnecting, failed

    public var japaneseLabel: String {
        switch self {
        case .idle: "音声会話を開始"
        case .requestingPermission: "マイクを準備中"
        case .connecting: "Geminiへ接続中"
        case .listening: "聞いています"
        case .thinking: "考えています"
        case .speaking: "シャノンが話しています"
        case .reconnecting: "会話をつなぎ直しています"
        case .failed: "接続できませんでした"
        }
    }
}

@MainActor
@Observable
public final class ShannonGeminiLiveSessionModel {
    public private(set) var phase: ShannonGeminiLivePhase = .idle
    public private(set) var userTranscript = ""
    public private(set) var shannonTranscript = ""
    public private(set) var model = "gemini-3.5-transcribe-live"
    public private(set) var voice = "Shannon"
    public private(set) var errorMessage: String?
    public private(set) var failureRecovery: ShannonGeminiLiveFailureRecovery?
    public private(set) var textSendState: ShannonGeminiTextSendState = .idle
    public private(set) var audioLevel: Float = 0
    public private(set) var playbackLevel: Double = 0
    public private(set) var firstAudioLatencyMilliseconds: Int?
    public private(set) var interruptionLatencyMilliseconds: Int?
    public private(set) var estimatedCostUsd: Double = 0
    public private(set) var inputAudioSeconds: Double = 0
    public private(set) var outputAudioSeconds: Double = 0
    public private(set) var participantMode: ShannonVoiceParticipantMode = .owner
    public private(set) var inputState: ShannonVoiceInputState

    private var session: ShannonGeminiLiveSessionDTO?
    private var transport: ShannonGeminiLiveTransport?
    private var transcriptBuffer = ""
    private var responseTask: Task<Void, Never>?
    private var finalizeTask: Task<Void, Never>?
    private var duckRestoreTask: Task<Void, Never>?
    private var bargeCandidateStartedAt: TimeInterval?
    private var responseStartedAt: TimeInterval?
    private var ttsCostUsd: Double = 0
    private var didRecordCaptureStart = false
    private var didRecordFirstQueuedChunk = false
    private var createSession: (@MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO)?
    private var performDelegation: (@MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> ShannonLiveVoiceDelegationResponseDTO)?
    private var streamSpeech: (@MainActor (String, String?) async throws -> ShannonGeminiSpeechStream)?
    private var commitTurn: (@MainActor (String, String) async throws -> Void)?

    private static let inputPreferenceDefaultsKey = "shannon.voice.input-preference"

    public init() {
        let stored = UserDefaults.standard.string(forKey: Self.inputPreferenceDefaultsKey)
        let preference = stored.flatMap(ShannonVoiceInputPreference.init(rawValue:)) ?? .automatic
        inputState = ShannonVoiceInputState(preference: preference)
    }

    public func start(
        participantMode: ShannonVoiceParticipantMode,
        createSession: @escaping @MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO,
        performDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> ShannonLiveVoiceDelegationResponseDTO,
        streamSpeech: @escaping @MainActor (String, String?) async throws -> ShannonGeminiSpeechStream,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {
        stop()
        self.createSession = createSession
        self.performDelegation = performDelegation
        self.streamSpeech = streamSpeech
        self.commitTurn = commitTurn
        self.participantMode = participantMode
        resetMeasurements()
        errorMessage = nil
        failureRecovery = nil
        phase = .requestingPermission

        guard ShannonVoiceUsageDescriptionPolicy.isPresent(
            Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription")
        ) else {
            fail("音声機能の設定が不足しています。アプリを更新してください。", recovery: .updateRequired)
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            fail("設定でマイクを許可すると、音声で話せます。", recovery: .openSettings)
            return
        }

        phase = .connecting
        do {
            let created = try await createSession(participantMode)
            session = created
            model = created.model
            voice = created.voice
            let next = ShannonGeminiLiveTransport(
                session: created,
                eventHandler: { [weak self] event in self?.handle(event) },
                captureHandler: { [weak self] rms, seconds, started, ended, chunks in
                    self?.handleCapture(rms: rms, seconds: seconds, started: started, ended: ended, chunks: chunks)
                },
                inputStateHandler: { [weak self] state in
                    self?.inputState = state
                }
            )
            transport = next
            try next.setInputPreference(inputState.preference)
            try await next.start()
        } catch {
            fail(
                "Gemini音声会話へ接続できませんでした。通信を確認して、もう一度お試しください。",
                recovery: .reconnect
            )
        }
    }

    public func stop() {
        textSendState.preservePendingText(
            message: "音声会話を閉じたため送信を中断しました。入力は残しています。"
        )
        responseTask?.cancel()
        finalizeTask?.cancel()
        duckRestoreTask?.cancel()
        responseTask = nil
        finalizeTask = nil
        duckRestoreTask = nil
        transport?.stop()
        transport = nil
        session = nil
        phase = .idle
        audioLevel = 0
        playbackLevel = 0
    }

    public func retry() async {
        guard let createSession, let performDelegation, let streamSpeech, let commitTurn else { return }
        await start(
            participantMode: participantMode,
            createSession: createSession,
            performDelegation: performDelegation,
            streamSpeech: streamSpeech,
            commitTurn: commitTurn
        )
    }

    @discardableResult
    public func sendText(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        guard transport != nil, performDelegation != nil, streamSpeech != nil, phase != .failed else {
            textSendState = .failed(
                text: value,
                message: "音声会話へ接続してから、もう一度送信してください。"
            )
            return false
        }
        guard !textSendState.isSending else { return false }
        interruptResponse(preserveTextFailure: false)
        userTranscript = value
        textSendState = .sending(text: value)
        beginResponse(to: value, textSubmission: value)
        return true
    }

    @discardableResult
    public func retryText() -> Bool {
        guard let text = textSendState.failedText else { return false }
        textSendState = .idle
        return sendText(text)
    }

    public func selectInput(_ preference: ShannonVoiceInputPreference) {
        guard inputState.canSelect(preference) else {
            errorMessage = "選んだマイクは現在接続されていません。"
            return
        }
        do {
            try transport?.setInputPreference(preference)
            inputState = ShannonVoiceInputState(
                preference: preference,
                activeInputName: inputState.activeInputName,
                isBuiltInAvailable: inputState.isBuiltInAvailable,
                isConnectedInputAvailable: inputState.isConnectedInputAvailable
            )
            UserDefaults.standard.set(preference.rawValue, forKey: Self.inputPreferenceDefaultsKey)
        } catch {
            errorMessage = "マイクを切り替えられませんでした。接続を確認してください。"
        }
    }

    public func shareCameraSnapshot(
        jpegData: Data,
        analyze: @escaping @MainActor (Data) async throws -> String
    ) async throws {
        guard participantMode.allowsCameraSharing else { throw ShannonRealtimeVoiceCameraError.sessionUnavailable }
        let description = try await analyze(jpegData)
        beginResponse(
            to: "いま共有した写真を見て、会話の流れに合わせて短くコメントして。画像の内容: \(description)",
            committedUserText: "写真を共有しました。"
        )
    }

    private func handle(_ event: ShannonGeminiLiveServerEvent) {
        switch event {
        case .setupComplete:
            phase = .listening
        case let .interimInputTranscript(text):
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            userTranscript = transcriptBuffer.isEmpty ? value : transcriptBuffer + value
            handleBargeIn(hasFinalText: false)
        case let .inputTranscript(text):
            transcriptBuffer = mergedTranscript(transcriptBuffer, text)
            userTranscript = transcriptBuffer
            handleBargeIn(hasFinalText: true)
            scheduleFinalization(turnComplete: false)
        case .turnComplete:
            scheduleFinalization(turnComplete: true)
        case .sessionHandle:
            break
        case .goAway:
            fail("Geminiとの接続が終了しました。もう一度つないでください。", recovery: .reconnect)
        }
    }

    private func handleCapture(rms: Float, seconds: Double, started: Bool, ended: Bool, chunks: Int) {
        if !didRecordCaptureStart {
            didRecordCaptureStart = true
            ShannonVoiceDiagnostics.shared.record("gemini.audio.capture.started")
        }
        if chunks > 0, !didRecordFirstQueuedChunk {
            didRecordFirstQueuedChunk = true
            ShannonVoiceDiagnostics.shared.record(
                "gemini.audio.chunk.queued",
                metadata: ["pcm_bytes": String(ShannonGeminiLiveAudioChunker.chunkByteCount)]
            )
        }
        audioLevel = min(1, max(0, rms * 18))
        inputAudioSeconds += seconds
        updateCost()
        if started, responseTask != nil {
            bargeCandidateStartedAt = ProcessInfo.processInfo.systemUptime
            transport?.setPlaybackVolume(0.18)
            scheduleDuckRelease()
        }
        if ended, responseTask == nil { phase = .thinking }
    }

    private func scheduleFinalization(turnComplete: Bool) {
        guard !transcriptBuffer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        finalizeTask?.cancel()
        let delay = ShannonGeminiCascadeSpeech.finalizeDelayMilliseconds(
            for: transcriptBuffer,
            turnComplete: turnComplete
        )
        finalizeTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
            self?.finalizeTranscript()
        }
    }

    private func finalizeTranscript() {
        finalizeTask?.cancel()
        finalizeTask = nil
        let text = transcriptBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
        transcriptBuffer = ""
        guard !text.isEmpty else { return }
        beginResponse(to: text)
    }

    private func beginResponse(
        to userText: String,
        committedUserText: String? = nil,
        textSubmission: String? = nil
    ) {
        guard let performDelegation, let streamSpeech else {
            if let textSubmission {
                textSendState = .failed(text: textSubmission, message: "送信を開始できませんでした。")
            }
            return
        }
        responseTask?.cancel()
        responseStartedAt = ProcessInfo.processInfo.systemUptime
        firstAudioLatencyMilliseconds = nil
        shannonTranscript = ""
        phase = .thinking
        responseTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let utterance = ShannonVoiceUserUtteranceDTO(id: UUID().uuidString, text: userText)
                let response = try await performDelegation(userText, utterance, participantMode)
                try Task.checkCancellation()
                if response.voicePlan?.shouldRespond == false {
                    phase = .listening
                    responseTask = nil
                    if let textSubmission,
                       case let .sending(currentText) = textSendState,
                       currentText == textSubmission {
                        textSendState = .idle
                    }
                    return
                }
                let reply = response.reply
                shannonTranscript = reply
                var playbackDeadline = ProcessInfo.processInfo.systemUptime
                try await ShannonGeminiSpeechPipeline.play(
                    segments: ShannonGeminiCascadeSpeech.segments(reply),
                    style: { ShannonGeminiCascadeSpeech.style(for: $0, plan: response.voicePlan) },
                    streamSpeech: streamSpeech
                ) { [self] speech in
                    try Task.checkCancellation()
                    self.voice = speech.voice
                    guard speech.sampleRate == 24_000,
                          speech.channels == 1,
                          speech.bitsPerSample == 16 else {
                        throw ShannonAPIError.invalidResponse
                    }
                    var segmentDuration = 0.0
                    for try await chunk in speech.chunks {
                        try Task.checkCancellation()
                        guard !chunk.isEmpty, chunk.count % 2 == 0 else {
                            throw ShannonAPIError.invalidResponse
                        }
                        if self.firstAudioLatencyMilliseconds == nil, let responseStartedAt = self.responseStartedAt {
                            self.firstAudioLatencyMilliseconds = Int(
                                (ProcessInfo.processInfo.systemUptime - responseStartedAt) * 1_000
                            )
                        }
                        let duration = try self.transport?.schedulePCM(chunk) ?? Double(chunk.count) / 48_000
                        segmentDuration += duration
                        self.outputAudioSeconds += duration
                        self.playbackLevel = 0.55
                        self.phase = .speaking
                        playbackDeadline = max(playbackDeadline, ProcessInfo.processInfo.systemUptime) + duration
                    }
                    guard segmentDuration > 0 else { throw ShannonAPIError.invalidResponse }
                    self.ttsCostUsd += segmentDuration / 10 * speech.outputUsdPerTenSeconds
                    self.updateCost()
                }
                let remaining = max(0, playbackDeadline - ProcessInfo.processInfo.systemUptime)
                try await Task.sleep(for: .seconds(remaining))
                try Task.checkCancellation()
                playbackLevel = 0
                phase = .listening
                responseTask = nil
                if let textSubmission,
                   case let .sending(currentText) = textSendState,
                   currentText == textSubmission {
                    textSendState = .idle
                }
                if participantMode.allowsTranscriptPersistence, let commitTurn {
                    try? await commitTurn(committedUserText ?? userText, reply)
                }
            } catch is CancellationError {
                return
            } catch {
                responseTask = nil
                playbackLevel = 0
                phase = .listening
                errorMessage = "返答の音声を作れませんでした。もう一度話しかけてください。"
                if let textSubmission {
                    textSendState = .failed(
                        text: textSubmission,
                        message: "返答を最後まで再生できませんでした。入力を残しています。"
                    )
                }
            }
        }
    }

    private func handleBargeIn(hasFinalText: Bool) {
        guard responseTask != nil else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if bargeCandidateStartedAt == nil {
            bargeCandidateStartedAt = now
            transport?.setPlaybackVolume(0.18)
        }
        scheduleDuckRelease()
        if hasFinalText || now - (bargeCandidateStartedAt ?? now) >= 0.34 {
            interruptResponse(preserveTextFailure: true)
        }
    }

    private func scheduleDuckRelease() {
        duckRestoreTask?.cancel()
        duckRestoreTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(850)) } catch { return }
            self?.transport?.setPlaybackVolume(1)
            self?.bargeCandidateStartedAt = nil
        }
    }

    private func interruptResponse(preserveTextFailure: Bool = true) {
        guard responseTask != nil else { return }
        if preserveTextFailure,
           case let .sending(text) = textSendState {
            textSendState = .failed(
                text: text,
                message: "音声入力で応答を中断しました。必要なら同じ文を再送できます。"
            )
        }
        let now = ProcessInfo.processInfo.systemUptime
        if let started = bargeCandidateStartedAt {
            interruptionLatencyMilliseconds = Int(max(0, now - started) * 1_000)
        }
        responseTask?.cancel()
        responseTask = nil
        duckRestoreTask?.cancel()
        duckRestoreTask = nil
        transport?.discardPlayback()
        transport?.setPlaybackVolume(1)
        playbackLevel = 0
        bargeCandidateStartedAt = nil
        phase = .listening
    }

    private func mergedTranscript(_ current: String, _ next: String) -> String {
        let incoming = next.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incoming.isEmpty else { return current }
        if incoming == current || current.hasSuffix(incoming) { return current }
        if incoming.hasPrefix(current) { return incoming }
        return current.isEmpty ? incoming : current + incoming
    }

    private func updateCost() {
        estimatedCostUsd = inputAudioSeconds / 60 * (session?.inputUsdPerMinute ?? 0) + ttsCostUsd
    }

    private func resetMeasurements() {
        userTranscript = ""
        shannonTranscript = ""
        transcriptBuffer = ""
        inputAudioSeconds = 0
        outputAudioSeconds = 0
        ttsCostUsd = 0
        estimatedCostUsd = 0
        firstAudioLatencyMilliseconds = nil
        interruptionLatencyMilliseconds = nil
        playbackLevel = 0
        didRecordCaptureStart = false
        didRecordFirstQueuedChunk = false
    }

    private func fail(
        _ message: String,
        recovery: ShannonGeminiLiveFailureRecovery = .reconnect
    ) {
        textSendState.preservePendingText(
            message: "接続が切れたため送信を中断しました。入力は残しています。"
        )
        responseTask?.cancel()
        responseTask = nil
        transport?.stop()
        transport = nil
        phase = .failed
        errorMessage = message
        failureRecovery = recovery
    }

#if DEBUG
    func prepareDesignPreview() {
        let arguments = ProcessInfo.processInfo.arguments
        participantMode = arguments.contains("-ShannonPreviewVoiceGuest") ? .guest : .owner
        userTranscript = "シャノン、今日の予定を一緒に整理して"
        shannonTranscript = "もちろん。まず優先したいことから確認しよう。"
        audioLevel = 0.34
        playbackLevel = 0.58
        errorMessage = nil
        failureRecovery = nil
        textSendState = .idle
        if arguments.contains("-ShannonPreviewVoiceFailed") {
            phase = .failed
            errorMessage = "Gemini音声会話へ接続できませんでした。通信を確認して、もう一度お試しください。"
            failureRecovery = .reconnect
            textSendState = .failed(
                text: "続きはテキストで送って",
                message: "テキストを送信できませんでした。入力は保持されています。"
            )
        } else if arguments.contains("-ShannonPreviewVoiceReconnecting") {
            phase = .reconnecting
        } else if arguments.contains("-ShannonPreviewVoiceListening") {
            phase = .listening
        } else {
            phase = .speaking
        }
    }
#endif
}
#endif
