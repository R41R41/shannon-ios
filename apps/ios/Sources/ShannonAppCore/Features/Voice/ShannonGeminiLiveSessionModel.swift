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
    private var performDelegation: (@MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String)?
    private var synthesize: (@MainActor (String, String?) async throws -> ShannonGeminiSpeech)?
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
        performDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String,
        synthesize: @escaping @MainActor (String, String?) async throws -> ShannonGeminiSpeech,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {
        stop()
        self.createSession = createSession
        self.performDelegation = performDelegation
        self.synthesize = synthesize
        self.commitTurn = commitTurn
        self.participantMode = participantMode
        resetMeasurements()
        errorMessage = nil
        phase = .requestingPermission

        guard ShannonVoiceUsageDescriptionPolicy.isPresent(
            Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription")
        ) else {
            fail("音声機能の設定が不足しています。アプリを更新してください。")
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            fail("設定でマイクを許可すると、音声で話せます。")
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
            fail("Gemini音声会話へ接続できませんでした。少し待ってもう一度お試しください。")
        }
    }

    public func stop() {
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
        guard let createSession, let performDelegation, let synthesize, let commitTurn else { return }
        await start(
            participantMode: participantMode,
            createSession: createSession,
            performDelegation: performDelegation,
            synthesize: synthesize,
            commitTurn: commitTurn
        )
    }

    public func sendText(_ text: String) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        interruptResponse()
        userTranscript = value
        beginResponse(to: value)
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
            fail("Geminiとの接続が終了しました。もう一度開始してください。")
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

    private func beginResponse(to userText: String, committedUserText: String? = nil) {
        guard let performDelegation, let synthesize else { return }
        responseTask?.cancel()
        responseStartedAt = ProcessInfo.processInfo.systemUptime
        firstAudioLatencyMilliseconds = nil
        shannonTranscript = ""
        phase = .thinking
        responseTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let utterance = ShannonVoiceUserUtteranceDTO(id: UUID().uuidString, text: userText)
                let reply = try await performDelegation(userText, utterance, participantMode)
                try Task.checkCancellation()
                shannonTranscript = reply
                var playbackDeadline = ProcessInfo.processInfo.systemUptime
                for segment in ShannonGeminiCascadeSpeech.segments(reply) {
                    let speech = try await synthesize(segment, ShannonGeminiCascadeSpeech.style(for: segment))
                    try Task.checkCancellation()
                    voice = speech.voice
                    if firstAudioLatencyMilliseconds == nil, let responseStartedAt {
                        firstAudioLatencyMilliseconds = Int(
                            (ProcessInfo.processInfo.systemUptime - responseStartedAt) * 1_000
                        )
                    }
                    let duration = try transport?.scheduleSpeech(speech) ?? speech.durationSeconds
                    outputAudioSeconds += duration
                    ttsCostUsd += speech.estimatedCostUsd
                    playbackLevel = 0.55
                    phase = .speaking
                    playbackDeadline = max(playbackDeadline, ProcessInfo.processInfo.systemUptime) + duration
                    updateCost()
                }
                let remaining = max(0, playbackDeadline - ProcessInfo.processInfo.systemUptime)
                try await Task.sleep(for: .seconds(remaining))
                try Task.checkCancellation()
                playbackLevel = 0
                phase = .listening
                responseTask = nil
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

    private func fail(_ message: String) {
        responseTask?.cancel()
        responseTask = nil
        transport?.stop()
        transport = nil
        phase = .failed
        errorMessage = message
    }
}
#endif
