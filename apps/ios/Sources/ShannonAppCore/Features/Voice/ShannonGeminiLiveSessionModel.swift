#if os(iOS)
import Foundation
import Observation
@preconcurrency import AVFoundation
@MainActor
@Observable
public final class ShannonGeminiLiveSessionModel {
    public internal(set) var phase: ShannonGeminiLivePhase = .idle
    public internal(set) var userTranscript = ""
    public internal(set) var shannonTranscript = ""
    public private(set) var model = "gpt-4o-mini-transcribe"
    public internal(set) var voice = "Shannon"
    public internal(set) var errorMessage: String?
    public internal(set) var failureRecovery: ShannonGeminiLiveFailureRecovery?
    public internal(set) var textSendState: ShannonGeminiTextSendState = .idle
    public internal(set) var audioLevel: Float = 0
    public internal(set) var playbackLevel: Double = 0
    public var firstAudioLatencyMilliseconds: Int? { latencyMeasurements.firstAudioMilliseconds }
    public var firstTextLatencyMilliseconds: Int? { latencyMeasurements.firstTextMilliseconds }
    public var firstTTSByteLatencyMilliseconds: Int? { latencyMeasurements.firstTTSByteMilliseconds }
    public var decisionLatencyMilliseconds: Int? { latencyMeasurements.decisionMilliseconds }
    public private(set) var interruptionLatencyMilliseconds: Int?
    public private(set) var estimatedCostUsd: Double = 0
    public private(set) var inputAudioSeconds: Double = 0
    public internal(set) var outputAudioSeconds: Double = 0
    public internal(set) var participantMode: ShannonVoiceParticipantMode = .owner
    public private(set) var speechProvider: ShannonSpeechProvider = .gemini
    public internal(set) var ttsCostEstimateAvailable = true
    public private(set) var inputState: ShannonVoiceInputState
    /// User-chosen mute. It survives a reconnect of the same call and resets when the call ends.
    public internal(set) var isMicrophoneMuted = false
    /// When the call first became ready to listen; kept across a reconnect of the same call.
    public internal(set) var callStartedAt: Date?
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
    var echoGuard = ShannonSpeechEchoGuard()
    /// Recognition lags speech, so Shannon's own last words can arrive as a transcript after playback ends.
    var echoWindow = ShannonVoiceEchoWindow()
    /// This call's 「友人も一緒」 turns. Memory only; dropped when the call ends.
    var guestCall = ShannonVoiceGuestCallState()
    private var bargeCandidateStartedAt: TimeInterval?
    private var heardRightAfterShannon = false
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
        let sameCall = preservePendingInput && self.participantMode == participantMode
        let retained = sameCall ? pendingTurns : ShannonPendingVoiceTurns()
        let retainedMute = sameCall && isMicrophoneMuted
        let retainedStart = sameCall ? callStartedAt : nil
        let retainedGuestCall = sameCall ? guestCall : ShannonVoiceGuestCallState()
        stop()
        guestCall = retainedGuestCall
        setKeepsScreenAwake(true)
        pendingTurns = retained
        isMicrophoneMuted = retainedMute
        callStartedAt = retainedStart
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
        userTranscript = pendingTurns.displayText
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
            ShannonVoiceDiagnostics.shared.record("gemini.session.created", metadata: [
                "provider": speechProvider.japaneseName, "model": created.model, "voice": created.voice])
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
            next.setInputMuted(isMicrophoneMuted)
            try next.setInputPreference(inputState.preference)
            try await next.start()
            if sessionGenerationID != generation { next.stop() }
        } catch {
            guard sessionGenerationID == generation else { return }
            let code = (error as NSError).code
            ShannonVoiceDiagnostics.shared.record("gemini.session.start.failed",
                metadata: ["stage": failedStage, "domain": (error as NSError).domain, "code": String(code)])
            fail(failedStage == "session"
                ? "音声会話へ接続できませんでした。通信を確認して、もう一度お試しください。"
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
        guestCall = ShannonVoiceGuestCallState()
        setKeepsScreenAwake(false)
        finalizeTask = nil
        duckRestoreTask = nil
        if session != nil { recordSessionSummary() }
        transport?.stop()
        transport = nil
        session = nil
        sessionGenerationID = nil
        phase = .idle
        isMicrophoneMuted = false
        callStartedAt = nil
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
        appendUtterance(rawText: value, text: value, source: .typed)
        userTranscript = pendingTurns.displayText
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

    public func toggleMicrophoneMute() {
        isMicrophoneMuted.toggle()
        if isMicrophoneMuted { audioLevel = 0 }
        transport?.setInputMuted(isMicrophoneMuted)
        ShannonVoiceDiagnostics.shared.record("gemini.audio.input.mute", metadata: ["muted": String(isMicrophoneMuted)])
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

    private func handle(_ event: ShannonTranscriptionEvent) {
        switch event {
        case .sessionReady:
            phase = .listening
            if callStartedAt == nil { callStartedAt = Date() }
        case .speechStarted:
            echoWindow.speechStarted(isSpeaking: responseTask != nil, now: ProcessInfo.processInfo.systemUptime)
            duckForSpeech()
        case .speechStopped:
            if responseTask != nil { scheduleDuckRelease() }
        case let .inputTranscript(text):
            if discardsAsEcho(text) { return }
            if !turnAssembler.hasFinalText {
                heardRightAfterShannon = ShannonVoiceGuestCallState.follows(
                    shannonTurnEndedAt: echoWindow.playbackEndedAt, isSpeaking: responseTask != nil,
                    now: ProcessInfo.processInfo.systemUptime)
            }
            turnAssembler.appendFinal(text)
            userTranscript = previewInput(turnAssembler.finalText)
            // Only a completed transcript that is not Shannon's own voice interrupts her reply.
            interruptResponse()
            scheduleFinalization(turnComplete: false)
        case .goAway:
            fail("音声会話の接続が終了しました。もう一度つないでください。", recovery: .reconnect)
        }
    }

    /// A transcript that repeats what Shannon just said is her own voice through the microphone,
    /// not the owner. Only the character count is logged, never the text.
    private func discardsAsEcho(_ text: String) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        let speaking = responseTask != nil
        guard echoWindow.shouldCompare(text, isSpeaking: speaking, now: now),
              echoGuard.isEcho(text, now: now) else { return false }
        ShannonVoiceDiagnostics.shared.record("gemini.input.echo.discarded",
            metadata: ["characters": String(text.count), "during_playback": String(speaking)])
        return true
    }

    func markPlaybackEnded() {
        echoWindow.playbackEnded(at: ProcessInfo.processInfo.systemUptime)
    }

    private func previewInput(_ current: String) -> String {
[pendingTurns.displayText, current].filter { !$0.isEmpty }.joined(separator: "\n")
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
        audioLevel = isMicrophoneMuted ? 0 : min(1, max(0, rms * 18))
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
        appendUtterance(id: envelope.id, rawText: envelope.rawText, text: envelope.normalizedText,
            source: .speech, addressedByName: envelope.addressee == "shannon",
            followsShannonTurn: heardRightAfterShannon)
        userTranscript = pendingTurns.displayText
        beginResponse()
    }
    /// A sound heard while Shannon speaks may be her own voice returning through the microphone, so
    /// it only lowers playback. The reply stops when a completed transcript shows the owner spoke
    /// (see `.inputTranscript`); the duck lifts shortly after the sound stops.
    private func duckForSpeech() {
        guard responseTask != nil else { return }
        if bargeCandidateStartedAt == nil { bargeCandidateStartedAt = ProcessInfo.processInfo.systemUptime }
        transport?.setPlaybackVolume(0.18)
        duckRestoreTask?.cancel()
        // Safety net in case the stop event never arrives.
        duckRestoreTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            self?.transport?.setPlaybackVolume(1)
            self?.bargeCandidateStartedAt = nil
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

    func interruptResponse() {
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
        markPlaybackEnded()
        duckRestoreTask?.cancel()
        duckRestoreTask = nil
        transport?.discardPlayback()
        transport?.setPlaybackVolume(1)
        playbackLevel = 0
        bargeCandidateStartedAt = nil
        phase = .listening
    }

    /// Speech heard but not yet turned into a turn must not cross a participant switch.
    func discardUnfinalizedInput() {
        finalizeTask?.cancel()
        finalizeTask = nil
        turnAssembler.reset()
        heardRightAfterShannon = false
    }

    func updateCost() {
        estimatedCostUsd = inputAudioSeconds / 60 * (session?.inputUsdPerMinute ?? 0) + ttsCostUsd
    }

    private func resetMeasurements() {
        userTranscript = ""
        shannonTranscript = ""
        turnAssembler.reset()
        echoGuard.reset()
        echoWindow.reset()
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
}
#endif
