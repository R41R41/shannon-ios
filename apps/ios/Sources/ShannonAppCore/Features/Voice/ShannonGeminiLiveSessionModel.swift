#if os(iOS)
import Foundation
import Observation
@preconcurrency import AVFoundation

public enum ShannonGeminiLivePhase: String, Equatable, Sendable {
    case idle
    case requestingPermission
    case connecting
    case listening
    case thinking
    case speaking
    case reconnecting
    case failed

    public var japaneseLabel: String {
        switch self {
        case .idle: "Gemini Liveを開始"
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
    public private(set) var model = "gemini-3.8-live"
    public private(set) var voice = "Aoede"
    public private(set) var errorMessage: String?
    public private(set) var audioLevel: Float = 0
    public private(set) var playbackLevel: Double = 0
    public private(set) var firstAudioLatencyMilliseconds: Int?
    public private(set) var interruptionLatencyMilliseconds: Int?
    public private(set) var estimatedCostUsd: Double = 0
    public private(set) var inputAudioSeconds: Double = 0
    public private(set) var outputAudioSeconds: Double = 0

    private var session: ShannonGeminiLiveSessionDTO?
    private var transport: ShannonGeminiLiveTransport?
    private var latestSessionHandle: String?
    private var speechEndedAt: TimeInterval?
    private var interruptionStartedAt: TimeInterval?
    private var turnUserTranscript = ""
    private var turnShannonTranscript = ""
    private var currentTurnInterrupted = false
    private var toolTasks: [String: Task<Void, Never>] = [:]
    private var commitTasks: [UUID: Task<Void, Never>] = [:]
    private var turnFinalizationTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var didAttemptResume = false
    private var createSession: (@MainActor () async throws -> ShannonGeminiLiveSessionDTO)?
    private var performDelegation: (@MainActor (String, ShannonVoiceUserUtteranceDTO?) async throws -> String)?
    private var commitTurn: (@MainActor (String, String) async throws -> Void)?

    public init() {}

    public func start(
        createSession: @escaping @MainActor () async throws -> ShannonGeminiLiveSessionDTO,
        performDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?) async throws -> String,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {
        stop()
        self.createSession = createSession
        self.performDelegation = performDelegation
        self.commitTurn = commitTurn
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
            let created = try await createSession()
            session = created
            model = created.model
            voice = created.voice
            try await connect(created, resumptionHandle: nil)
        } catch {
            fail("Geminiライブ音声へ接続できませんでした。少し待ってもう一度お試しください。")
        }
    }

    public func stop() {
        reconnectTask?.cancel()
        reconnectTask = nil
        if turnFinalizationTask != nil {
            finalizeCompletedTurn()
        }
        for task in toolTasks.values { task.cancel() }
        toolTasks.removeAll()
        transport?.stop()
        transport = nil
        session = nil
        latestSessionHandle = nil
        createSession = nil
        performDelegation = nil
        commitTurn = nil
        phase = .idle
        audioLevel = 0
        playbackLevel = 0
    }

    public func retry() async {
        guard let createSession, let performDelegation, let commitTurn else { return }
        await start(
            createSession: createSession,
            performDelegation: performDelegation,
            commitTurn: commitTurn
        )
    }

    private func connect(_ session: ShannonGeminiLiveSessionDTO, resumptionHandle: String?) async throws {
        let next = ShannonGeminiLiveTransport(
            session: session,
            eventHandler: { [weak self] event in self?.handle(event) },
            captureHandler: { [weak self] rms, seconds, started, ended in
                self?.handleCapture(rms: rms, seconds: seconds, speechStarted: started, speechEnded: ended)
            }
        )
        transport = next
        try await next.start(resumptionHandle: resumptionHandle)
    }

    private func handle(_ event: ShannonGeminiLiveServerEvent) {
        switch event {
        case .setupComplete:
            didAttemptResume = false
            phase = .listening
        case let .audio(data):
            outputAudioSeconds += Double(data.count) / 48_000
            playbackLevel = Double(ShannonGeminiLivePCM.rootMeanSquare(pcm16: data))
            updateCost()
            if let speechEndedAt, firstAudioLatencyMilliseconds == nil {
                firstAudioLatencyMilliseconds = max(0, Int(
                    (ProcessInfo.processInfo.systemUptime - speechEndedAt) * 1_000
                ))
            }
            phase = .speaking
        case let .inputTranscript(text):
            turnUserTranscript = mergedTranscript(turnUserTranscript, text)
            userTranscript = turnUserTranscript
        case let .outputTranscript(text):
            turnShannonTranscript = mergedTranscript(turnShannonTranscript, text)
            shannonTranscript = turnShannonTranscript
        case .interrupted:
            currentTurnInterrupted = true
            playbackLevel = 0
            transport?.discardPlayback()
            if let interruptionStartedAt {
                interruptionLatencyMilliseconds = max(0, Int(
                    (ProcessInfo.processInfo.systemUptime - interruptionStartedAt) * 1_000
                ))
            }
            self.interruptionStartedAt = nil
            phase = .listening
        case .turnComplete:
            playbackLevel = 0
            phase = .listening
            if currentTurnInterrupted {
                discardInterruptedTurn()
            } else {
                scheduleTurnFinalization()
            }
        case let .toolCall(id, request):
            performToolCall(id: id, request: request)
        case let .sessionHandle(handle):
            latestSessionHandle = handle
        case let .goAway(timeLeft):
            if timeLeft != nil {
                phase = .reconnecting
            } else {
                resumeIfPossible()
            }
        }
    }

    private func handleCapture(
        rms: Float,
        seconds: Double,
        speechStarted: Bool,
        speechEnded: Bool
    ) {
        audioLevel = min(1, max(0, rms * 18))
        inputAudioSeconds += seconds
        updateCost()
        if speechStarted {
            if turnFinalizationTask != nil {
                finalizeCompletedTurn()
            }
            if turnUserTranscript.isEmpty && turnShannonTranscript.isEmpty {
                userTranscript = ""
                shannonTranscript = ""
            }
            if phase == .speaking {
                currentTurnInterrupted = true
                interruptionStartedAt = ProcessInfo.processInfo.systemUptime
                transport?.discardPlayback()
            }
            if phase != .connecting && phase != .reconnecting { phase = .listening }
            speechEndedAt = nil
            firstAudioLatencyMilliseconds = nil
        }
        if speechEnded {
            speechEndedAt = ProcessInfo.processInfo.systemUptime
            phase = .thinking
        }
    }

    private func performToolCall(id: String, request: String) {
        guard toolTasks[id] == nil, let performDelegation else { return }
        phase = .thinking
        let utteranceText = turnUserTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let utterance = utteranceText.isEmpty ? nil : ShannonVoiceUserUtteranceDTO(
            id: UUID().uuidString,
            text: utteranceText
        )
        toolTasks[id] = Task { @MainActor [weak self] in
            defer { self?.toolTasks[id] = nil }
            do {
                let result = try await performDelegation(request, utterance)
                guard !Task.isCancelled else { return }
                try self?.transport?.sendToolResponse(id: id, result: result)
            } catch {
                guard !Task.isCancelled else { return }
                try? self?.transport?.sendToolResponse(
                    id: id,
                    result: "確認に失敗しました。推測せず、必要な情報をユーザーに短く聞き直してください。"
                )
            }
        }
    }

    private func persistCompletedTurn() {
        let user = turnUserTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let shannon = turnShannonTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        turnUserTranscript = ""
        turnShannonTranscript = ""
        guard !user.isEmpty, !shannon.isEmpty, let commitTurn else { return }
        let id = UUID()
        commitTasks[id] = Task { @MainActor [weak self] in
            defer { self?.commitTasks[id] = nil }
            try? await commitTurn(user, shannon)
        }
    }

    private func scheduleTurnFinalization() {
        turnFinalizationTask?.cancel()
        turnFinalizationTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(350))
            } catch {
                return
            }
            self?.finalizeCompletedTurn()
        }
    }

    private func finalizeCompletedTurn() {
        turnFinalizationTask?.cancel()
        turnFinalizationTask = nil
        persistCompletedTurn()
    }

    private func discardInterruptedTurn() {
        turnFinalizationTask?.cancel()
        turnFinalizationTask = nil
        turnUserTranscript = ""
        turnShannonTranscript = ""
        currentTurnInterrupted = false
    }

    private func resumeIfPossible() {
        guard reconnectTask == nil,
              !didAttemptResume,
              let session,
              let latestSessionHandle else {
            fail("Geminiとの接続が終了しました。もう一度開始してください。")
            return
        }
        didAttemptResume = true
        phase = .reconnecting
        reconnectTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { reconnectTask = nil }
            transport?.stop()
            do {
                try await connect(session, resumptionHandle: latestSessionHandle)
            } catch {
                fail("会話をつなぎ直せませんでした。もう一度開始してください。")
            }
        }
    }

    private func mergedTranscript(_ current: String, _ next: String) -> String {
        let incoming = next.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incoming.isEmpty else { return current }
        if incoming == current || current.hasSuffix(incoming) { return current }
        if incoming.hasPrefix(current) { return incoming }
        return current.isEmpty ? incoming : current + incoming
    }

    private func updateCost() {
        guard let session else { return }
        estimatedCostUsd = inputAudioSeconds / 60 * session.inputUsdPerMinute
            + outputAudioSeconds / 60 * session.outputUsdPerMinute
    }

    private func resetMeasurements() {
        userTranscript = ""
        shannonTranscript = ""
        turnUserTranscript = ""
        turnShannonTranscript = ""
        currentTurnInterrupted = false
        inputAudioSeconds = 0
        outputAudioSeconds = 0
        estimatedCostUsd = 0
        firstAudioLatencyMilliseconds = nil
        interruptionLatencyMilliseconds = nil
        speechEndedAt = nil
        interruptionStartedAt = nil
        playbackLevel = 0
        latestSessionHandle = nil
        didAttemptResume = false
    }

    private func fail(_ message: String) {
        transport?.stop()
        transport = nil
        phase = .failed
        errorMessage = message
    }
}
#endif
