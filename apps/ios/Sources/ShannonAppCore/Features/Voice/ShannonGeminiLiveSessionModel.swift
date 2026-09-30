#if os(iOS)
import Foundation
import Observation
@preconcurrency import AVFoundation
@MainActor
@Observable
public final class ShannonGeminiLiveSessionModel {
    public internal(set) var phase: ShannonGeminiLivePhase = .idle
    public private(set) var userTranscript = ""
    public internal(set) var shannonTranscript = ""
    public private(set) var model = "gemini-3.5-transcribe-live"
    public internal(set) var voice = "Shannon"
    public internal(set) var errorMessage: String?
    public private(set) var failureRecovery: ShannonGeminiLiveFailureRecovery?
    public internal(set) var textSendState: ShannonGeminiTextSendState = .idle
    public private(set) var audioLevel: Float = 0
    public internal(set) var playbackLevel: Double = 0
    public var firstAudioLatencyMilliseconds: Int? { latencyMeasurements.firstAudioMilliseconds }
    public var firstTextLatencyMilliseconds: Int? { latencyMeasurements.firstTextMilliseconds }
    public var firstTTSByteLatencyMilliseconds: Int? { latencyMeasurements.firstTTSByteMilliseconds }
    public var decisionLatencyMilliseconds: Int? { latencyMeasurements.decisionMilliseconds }
    public private(set) var interruptionLatencyMilliseconds: Int?
    public private(set) var estimatedCostUsd: Double = 0
    public private(set) var inputAudioSeconds: Double = 0
    public internal(set) var outputAudioSeconds: Double = 0
    public private(set) var participantMode: ShannonVoiceParticipantMode = .owner
    public private(set) var speechProvider: ShannonSpeechProvider = .gemini
    public internal(set) var ttsCostEstimateAvailable = true
    public private(set) var inputState: ShannonVoiceInputState
    public internal(set) var microphonePrimerPhase: ShannonPermissionPrimerPhase?
    var microphonePrimerContinuation: CheckedContinuation<Bool, Never>?
    var microphonePermission: @MainActor () -> ShannonMediaPermission = ShannonMediaPermission.currentMicrophone
    var requestMicrophonePermission: @MainActor () async -> Bool = { await AVAudioApplication.requestRecordPermission() }
    private var session: ShannonGeminiLiveSessionDTO?
    private(set) var sessionGenerationID: UUID?
    var transport: ShannonGeminiLiveTransport?
    var pendingTurns = ShannonPendingVoiceTurns()
    var responseGenerationID: UUID?
    private var turnAssembler = ShannonVoiceTurnAssembler()
    var responseTask: Task<Void, Never>?
    private var finalizeTask: Task<Void, Never>?
    private var duckRestoreTask: Task<Void, Never>?
    private var bargeCandidateStartedAt: TimeInterval?
    var latencyMeasurements = ShannonVoiceLatencyMeasurements()
    var responseDelivery = ShannonVoiceResponseDelivery()
    var responseCommitTask: Task<Bool, Never>?
    var ttsCostUsd: Double = 0
    private var didRecordCaptureStart = false
    private var didRecordFirstQueuedChunk = false
    private var createSession: (@MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO)?
    private var performDelegation: (@MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> ShannonLiveVoiceDelegationResponseDTO)?
    var performStreamingDelegation: ShannonVoiceStreamingDelegation?
    var streamSpeech: (@MainActor (String, String?) async throws -> ShannonGeminiSpeechStream)?
    var commitTurn: (@MainActor (String, String) async throws -> Void)?
    var handleDelegationResponse: (@MainActor (ShannonLiveVoiceDelegationResponseDTO) -> Void)?
    private static let inputPreferenceDefaultsKey = "shannon.voice.input-preference"
    public init() {
        let stored = UserDefaults.standard.string(forKey: Self.inputPreferenceDefaultsKey)
        let preference = stored.flatMap(ShannonVoiceInputPreference.init(rawValue:)) ?? .automatic
        inputState = ShannonVoiceInputState(preference: preference)
    }

    public func start(
        participantMode: ShannonVoiceParticipantMode,
        speechProvider: ShannonSpeechProvider = .gemini,
        preservePendingInput: Bool = false,
        createSession: @escaping @MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO,
        performDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> ShannonLiveVoiceDelegationResponseDTO,
        performStreamingDelegation: @escaping ShannonVoiceStreamingDelegation,
        streamSpeech: @escaping @MainActor (String, String?) async throws -> ShannonGeminiSpeechStream,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void,
        handleDelegationResponse: @escaping @MainActor (ShannonLiveVoiceDelegationResponseDTO) -> Void
    ) async {
        let retained = preservePendingInput && self.participantMode == participantMode
            ? pendingTurns : ShannonPendingVoiceTurns()
        stop()
        pendingTurns = retained
        let generation = UUID()
        sessionGenerationID = generation
        self.createSession = createSession
        self.performDelegation = performDelegation
        self.performStreamingDelegation = performStreamingDelegation
        self.streamSpeech = streamSpeech
        self.commitTurn = commitTurn
        self.handleDelegationResponse = handleDelegationResponse
        self.participantMode = participantMode
        self.speechProvider = speechProvider
        resetMeasurements()
        userTranscript = pendingTurns.turns.map(\.rawText).joined(separator: "\n")
        errorMessage = nil
        failureRecovery = nil
        phase = .requestingPermission

        guard ShannonVoiceUsageDescriptionPolicy.isPresent(
            Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription")
        ) else {
            fail("音声機能の設定が不足しています。アプリを更新してください。", recovery: .updateRequired)
            return
        }
        guard await passMicrophonePrimer(generation: generation) else { return }
        let permitted = await requestMicrophonePermission()
        guard sessionGenerationID == generation else { return }
        guard permitted else {
            microphonePrimerPhase = .denied
            fail("設定でマイクを許可すると、音声で話せます。", recovery: .openSettings)
            return
        }
        microphonePrimerPhase = nil

        phase = .connecting
        var failedStage = "session"
        do {
            let created = try await createSession(participantMode)
            failedStage = "audio"
            guard sessionGenerationID == generation else { return }
            session = created
            model = created.model
            voice = created.voice
            let next = ShannonGeminiLiveTransport(
                session: created,
                eventHandler: { [weak self] event in
                    guard self?.sessionGenerationID == generation else { return }
                    self?.handle(event)
                },
                captureHandler: { [weak self] rms, seconds, started, ended, chunks in
                    guard self?.sessionGenerationID == generation else { return }
                    self?.handleCapture(rms: rms, seconds: seconds, started: started, ended: ended, chunks: chunks)
                },
                inputStateHandler: { [weak self] state in
                    guard self?.sessionGenerationID == generation else { return }
                    self?.inputState = state
                }
            )
            transport = next
            try next.setInputPreference(inputState.preference)
            try await next.start()
            if sessionGenerationID != generation { next.stop() }
        } catch {
            guard sessionGenerationID == generation else { return }
            let code = (error as NSError).code
            ShannonVoiceDiagnostics.shared.record("gemini.session.start.failed",
                metadata: ["stage": failedStage, "domain": (error as NSError).domain, "code": String(code)])
            fail(failedStage == "session"
                ? "Gemini音声会話へ接続できませんでした。通信を確認して、もう一度お試しください。"
                : "マイクや音声の準備ができませんでした。ほかのアプリがマイクを使っていないか確認して、もう一度お試しください。",
                recovery: .reconnect)
        }
    }

    public func stop() {
        resolveMicrophonePrimer(proceed: false)
        microphonePrimerPhase = nil
        textSendState.preservePendingText(
            message: "音声会話を閉じたため送信を中断しました。入力は残しています。"
        )
        responseTask?.cancel()
        finalizeTask?.cancel()
        duckRestoreTask?.cancel()
        responseTask = nil
        responseGenerationID = nil
        pendingTurns.reset()
        finalizeTask = nil
        duckRestoreTask = nil
        transport?.stop()
        transport = nil
        session = nil
        sessionGenerationID = nil
        phase = .idle
        audioLevel = 0
        playbackLevel = 0
    }

    public func retry() async {
        guard let createSession, let performDelegation, let performStreamingDelegation,
              let streamSpeech, let commitTurn, let handleDelegationResponse else { return }
        await start(
            participantMode: participantMode,
            speechProvider: speechProvider,
            preservePendingInput: true,
            createSession: createSession,
            performDelegation: performDelegation,
            performStreamingDelegation: performStreamingDelegation,
            streamSpeech: streamSpeech,
            commitTurn: commitTurn,
            handleDelegationResponse: handleDelegationResponse
        )
    }

    @discardableResult
    public func sendText(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        guard value.utf16.count <= 8_000 else {
            textSendState = .failed(text: value, message: "入力が長すぎます。短く分けて送信してください。")
            return false
        }
        guard transport != nil, performDelegation != nil, streamSpeech != nil, phase != .failed else {
            textSendState = .failed(
                text: value,
                message: "音声会話へ接続してから、もう一度送信してください。"
            )
            return false
        }
        interruptResponse()
        pendingTurns.append(rawText: value, text: value, source: .typed)
        userTranscript = pendingTurns.turns.map(\.rawText).joined(separator: "\n")
        textSendState = .sending(text: value)
        beginResponse()
        return true
    }

    @discardableResult
    public func retryText() -> Bool {
        guard let text = textSendState.failedText else { return false }
        if pendingTurns.turns.contains(where: { $0.source == .typed && $0.text == text }),
           transport != nil, phase != .failed {
            textSendState = .sending(text: text)
            beginResponse()
            return true
        }
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
                isConnectedInputAvailable: inputState.isConnectedInputAvailable,
                isPreferenceUnavailable: false
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
        let generation = sessionGenerationID
        let description = try await analyze(jpegData)
        guard sessionGenerationID == generation, participantMode.allowsCameraSharing,
              transport != nil else { throw ShannonRealtimeVoiceCameraError.sessionUnavailable }
        interruptResponse()
        pendingTurns.append(rawText: "写真を共有しました。",
            text: "いま共有した写真を見て、会話の流れに合わせて短くコメントして。画像の内容: \(description)",
            source: .camera)
        beginResponse()
    }

    private func handle(_ event: ShannonGeminiLiveServerEvent) {
        switch event {
        case .setupComplete:
            phase = .listening
        case let .interimInputTranscript(text):
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            userTranscript = previewInput(turnAssembler.preview(interim: value))
            handleBargeIn(hasFinalText: false)
        case let .inputTranscript(text):
            turnAssembler.appendFinal(text)
            userTranscript = previewInput(turnAssembler.finalText)
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

    private func previewInput(_ current: String) -> String {
        (pendingTurns.turns.map(\.rawText) + [current]).joined(separator: "\n")
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
        guard turnAssembler.hasFinalText else { return }
        finalizeTask?.cancel()
        let delay = turnAssembler.finalizationDelayMilliseconds(turnComplete: turnComplete)
        ShannonVoiceTurnDiagnostics.recordFinalizationScheduled(delay: delay, turnComplete: turnComplete)
        finalizeTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
            self?.finalizeTranscript(turnComplete: turnComplete)
        }
    }

    private func finalizeTranscript(turnComplete: Bool) {
        finalizeTask?.cancel()
        finalizeTask = nil
        guard let envelope = turnAssembler.finish() else { return }
        ShannonVoiceTurnDiagnostics.recordAssembled(envelope, turnComplete: turnComplete)
        userTranscript = envelope.normalizedText
        pendingTurns.append(id: envelope.id, rawText: envelope.rawText, text: envelope.normalizedText, source: .speech)
        userTranscript = pendingTurns.turns.map(\.rawText).joined(separator: "\n")
        beginResponse()
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
            interruptResponse()
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

    private func interruptResponse() {
        guard responseTask != nil else { return }
        ShannonVoiceDiagnostics.shared.record("gemini.response.interrupted",
            sessionID: responseGenerationID?.uuidString,
            metadata: ["reply_complete": String(responseDelivery.response != nil),
                "pending_input_count": String(pendingTurns.turns.count)])
        // Typed input is still pending, not failed: the next response includes it.
        let now = ProcessInfo.processInfo.systemUptime
        if let started = bargeCandidateStartedAt {
            interruptionLatencyMilliseconds = Int(max(0, now - started) * 1_000)
        }
        responseTask?.cancel()
        responseTask = nil
        responseGenerationID = nil
        duckRestoreTask?.cancel()
        duckRestoreTask = nil
        transport?.discardPlayback()
        transport?.setPlaybackVolume(1)
        playbackLevel = 0
        bargeCandidateStartedAt = nil
        phase = .listening
    }

    func updateCost() {
        estimatedCostUsd = inputAudioSeconds / 60 * (session?.inputUsdPerMinute ?? 0) + ttsCostUsd
    }

    private func resetMeasurements() {
        userTranscript = ""
        shannonTranscript = ""
        turnAssembler.reset()
        inputAudioSeconds = 0
        outputAudioSeconds = 0
        ttsCostUsd = 0
        ttsCostEstimateAvailable = true
        estimatedCostUsd = 0
        latencyMeasurements.reset()
        interruptionLatencyMilliseconds = nil
        playbackLevel = 0
        didRecordCaptureStart = false
        didRecordFirstQueuedChunk = false
    }

    func fail(
        _ message: String,
        recovery: ShannonGeminiLiveFailureRecovery = .reconnect
    ) {
        textSendState.preservePendingText(
            message: "接続が切れたため送信を中断しました。入力は残しています。"
        )
        responseTask?.cancel()
        responseTask = nil
        responseGenerationID = nil
        transport?.stop()
        transport = nil
        sessionGenerationID = nil
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
        if arguments.contains("-ShannonPreviewMicrophonePrimer") {
            phase = .requestingPermission
            let denied = arguments.contains("-ShannonPreviewPrimerDenied")
            microphonePrimerPhase = denied ? .denied : .explain
            if denied { fail("設定でマイクを許可すると、音声で話せます。", recovery: .openSettings) }
            return
        }
        if arguments.contains("-ShannonPreviewVoiceAudioFailed") {
            phase = .listening
            var fixtureLedger = ShannonPendingVoiceTurns()
            fixtureLedger.append(rawText: userTranscript, text: userTranscript, source: .speech)
            if let batch = fixtureLedger.batch() {
                do {
                    try responseDelivery.complete(.init(threadId: "synthetic-preview", model: "synthetic",
                        reply: shannonTranscript), batch: batch, ledger: &fixtureLedger)
                } catch { preconditionFailure("Invalid synthetic voice preview") }
            }
            errorMessage = responseDelivery.failureMessage
        } else if arguments.contains("-ShannonPreviewVoicePartialFailed") {
            phase = .listening
            responseDelivery = ShannonVoiceResponseDelivery()
            responseDelivery.scheduledAudio(seconds: 1)
            shannonTranscript = "まず優先したいことから……"
            errorMessage = responseDelivery.failureMessage
        } else if arguments.contains("-ShannonPreviewVoiceFailed") {
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
