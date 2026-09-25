import Foundation
import Observation

#if os(iOS) && canImport(WebRTC)
@preconcurrency import AVFoundation

@MainActor
@Observable
public final class ShannonRealtimeVoiceSessionModel {
    public internal(set) var phase: ShannonRealtimeVoicePhase = .idle
    public internal(set) var userTranscript = ""
    public internal(set) var shannonTranscript = ""
    public internal(set) var errorMessage: String?
    public private(set) var isMuted = false
    public private(set) var sessionStartedAt: Date?
    public internal(set) var usage = ShannonRealtimeVoiceUsage.zero
    public private(set) var dailyRemainingSeconds: Int?
    public private(set) var engine: ShannonVoiceEngine = .realtime
    public private(set) var liveAudioSeconds: Double = 0
    public private(set) var participantMode: ShannonVoiceParticipantMode = .owner
    public private(set) var inputState: ShannonVoiceInputState
    public private(set) var isSendingText = false
    public private(set) var textSendErrorMessage: String?
    public internal(set) var microphoneLevel: Double = 0
    public internal(set) var playbackLevel: Double = 0

    var transport: ShannonWebRTCVoiceTransport?
    var transcriptState = ShannonRealtimeVoiceTranscriptState()
    var turnCoordinator = ShannonRealtimeTurnCoordinator()
    var liveUserSpeaking = false
    var sessionLimitTask: Task<Void, Never>?
    var disconnectGraceTask: Task<Void, Never>?
    var commitTurn: (@MainActor (String, String) async throws -> Void)?
    var performLiveDelegation: (@MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String)?
    var liveDelegationTasks: [String: Task<Void, Never>] = [:]
    var sessionGeneration = 0
    let diagnostics = ShannonVoiceDiagnostics.shared
    static let inputPreferenceDefaultsKey = "shannon.voice.input-preference"

    public init() {
        let stored = UserDefaults.standard.string(forKey: Self.inputPreferenceDefaultsKey)
        let preference = stored.flatMap(ShannonVoiceInputPreference.init(rawValue:)) ?? .automatic
        inputState = ShannonVoiceInputState(preference: preference)
    }

    public var canSendText: Bool {
        phase.keepsSessionActive && sessionStartedAt != nil && !isSendingText
    }
    public var pendingToolCount: Int { liveDelegationTasks.count }

    public func start(
        participantMode: ShannonVoiceParticipantMode,
        createCall: @escaping @MainActor (String, ShannonVoiceParticipantMode) async throws -> ShannonRealtimeVoiceCallDTO,
        performLiveDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {
        stop()
        self.participantMode = participantMode
        sessionGeneration += 1
        let generation = sessionGeneration
        phase = .requestingPermission
        errorMessage = nil
        userTranscript = ""
        shannonTranscript = ""
        transcriptState = ShannonRealtimeVoiceTranscriptState()
        turnCoordinator = ShannonRealtimeTurnCoordinator()
        liveUserSpeaking = false
        usage = .zero
        engine = .realtime
        liveAudioSeconds = 0
        dailyRemainingSeconds = nil
        isSendingText = false
        textSendErrorMessage = nil
        microphoneLevel = 0
        playbackLevel = 0
        diagnostics.record("realtime.start.requested")

        let granted = await AVAudioApplication.requestRecordPermission()
        guard generation == sessionGeneration else { return }
        guard granted else {
            phase = .failed
            errorMessage = "設定でマイクを許可すると、シャノンと話せます。"
            diagnostics.record("realtime.permission.denied")
            return
        }

        phase = .connecting
        self.commitTurn = commitTurn
        self.performLiveDelegation = performLiveDelegation
        let transport = ShannonWebRTCVoiceTransport()
        self.transport = transport
        transport.onEvent = { [weak self] data in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.receive(data, generation: generation)
            }
        }
        transport.onConnectionState = { [weak self] state in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.receiveConnectionState(state, generation: generation)
            }
        }
        transport.onAudioInterruption = { [weak self] event in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.receiveAudioInterruption(event)
            }
        }
        transport.onAudioRouteChange = { [weak self] reason, inputPorts, outputPorts in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.diagnostics.record(
                    "realtime.audio.route_changed",
                    metadata: [
                        "reason": String(reason),
                        "input_port": inputPorts,
                        "output_port": outputPorts,
                    ]
                )
            }
        }
        transport.onAudioInputStateChange = { [weak self] state in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.inputState = state
            }
        }
        transport.onAudioServicesReset = { [weak self] in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.diagnostics.record("realtime.audio.services_reset")
                self?.fail("iPhoneの音声機能が再起動されました。もう一度つなぐと再開できます。")
            }
        }
        transport.onMicrophoneLevel = { [weak self] level in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.microphoneLevel = Double(level)
            }
        }
        transport.onPlaybackLevel = { [weak self] level in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.playbackLevel = Double(level)
            }
        }

        do {
            try transport.setInputPreference(inputState.preference)
            diagnostics.record("realtime.offer.before")
            let offer = try await transport.createOffer()
            diagnostics.record(
                "realtime.offer.after",
                metadata: ShannonRealtimeOfferDiagnostics(sdp: offer).metadata
            )
            let call = try await createCall(offer, participantMode)
            guard generation == sessionGeneration else {
                transport.close()
                return
            }
            engine = call.engine
            diagnostics.record("realtime.answer.received", metadata: [
                "model": call.model ?? "unknown",
                "engine": call.engine.rawValue,
            ])
            dailyRemainingSeconds = call.dailyRemainingSeconds
            try await transport.acceptAnswer(call.answerSDP)
            guard generation == sessionGeneration else {
                transport.close()
                return
            }
            if call.engine == .realtime {
                markSessionReady()
            }
        } catch {
            guard generation == sessionGeneration else { return }
            diagnostics.record("realtime.start.failed", metadata: safeErrorMetadata(error))
            fail(ShannonRealtimeVoiceFailurePresentation.startMessage(for: error))
        }
    }

    public func toggleMute() {
        isMuted.toggle()
        if isMuted { microphoneLevel = 0 }
        transport?.setMuted(isMuted)
    }

    public func selectInput(_ preference: ShannonVoiceInputPreference) {
        guard inputState.canSelect(preference) else {
            errorMessage = "選んだマイクは現在接続されていません。"
            return
        }
        let previous = inputState.preference
        do {
            try transport?.setInputPreference(preference)
            inputState = ShannonVoiceInputState(
                preference: preference,
                activeInputName: inputState.activeInputName,
                isBuiltInAvailable: inputState.isBuiltInAvailable,
                isConnectedInputAvailable: inputState.isConnectedInputAvailable
            )
            UserDefaults.standard.set(preference.rawValue, forKey: Self.inputPreferenceDefaultsKey)
            diagnostics.record("realtime.audio.input_selected", metadata: ["preference": preference.rawValue])
        } catch {
            try? transport?.setInputPreference(previous)
            errorMessage = "マイクを切り替えられませんでした。接続を確認して、もう一度お試しください。"
            diagnostics.record("realtime.audio.input_selection_failed", metadata: safeErrorMetadata(error))
        }
    }

    public func sendText(_ content: String) async throws {
        let normalized = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { throw ShannonRealtimeVoiceTextError.emptyMessage }
        guard canSendText, let transport else { throw ShannonRealtimeVoiceTextError.sessionUnavailable }
        let boundedContent = String(normalized.prefix(8_000))
        let generation = sessionGeneration
        let itemID = "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        invalidateVoiceWork()
        turnCoordinator.beginUserTurn(itemID: itemID, text: boundedContent)
        let turnEpoch = turnCoordinator.epoch
        isSendingText = true
        textSendErrorMessage = nil
        phase = .thinking
        if let completed = transcriptState.beginTypedUserTurn(boundedContent) {
            persist(completed, generation: generation)
        }
        userTranscript = transcriptState.userText
        shannonTranscript = transcriptState.shannonText

        do {
            if engine == .live {
                guard let performLiveDelegation else {
                    throw ShannonRealtimeVoiceTextError.sessionUnavailable
                }
                let reply = try await performLiveDelegation(boundedContent,
                    .init(id: itemID, text: boundedContent), participantMode)
                guard generation == sessionGeneration, turnEpoch == turnCoordinator.epoch, self.transport === transport else {
                    throw ShannonRealtimeVoiceTextError.sessionEnded
                }
                try transport.send(ShannonLiveVoiceClientEvent.commentary(
                    delegationID: nil,
                    content: reply
                ))
            } else {
                try sendRealtimeUserItem(boundedContent, itemID: itemID)
            }
            diagnostics.record("realtime.text.sent", metadata: ["engine": engine.rawValue])
            isSendingText = false
        } catch {
            guard generation == sessionGeneration else { throw error }
            isSendingText = false
            if phase == .thinking { phase = .listening }
            textSendErrorMessage = "テキストを送れませんでした。入力内容を残したまま、もう一度試せます。"
            diagnostics.record("realtime.text.failed", metadata: safeErrorMetadata(error))
            throw error
        }
    }

    public func shareCameraSnapshot(
        jpegData: Data,
        analyze: @escaping @MainActor (Data) async throws -> String
    ) async throws {
        guard phase.keepsSessionActive, let transport else {
            throw ShannonRealtimeVoiceCameraError.sessionUnavailable
        }
        let generation = sessionGeneration
        let turnEpoch = turnCoordinator.epoch
        phase = .thinking
        do {
            let description = try await analyze(jpegData)
            guard generation == sessionGeneration, turnEpoch == turnCoordinator.epoch, self.transport === transport else {
                throw ShannonRealtimeVoiceCameraError.sessionEnded
            }
            let observation = "ユーザーが確認して共有した1枚の写真についての観察です。撮影時刻は不明です。\n\(description)"
            if engine == .live {
                try transport.send(ShannonLiveVoiceClientEvent.commentary(
                    delegationID: nil,
                    content: observation
                ))
            } else {
                let itemID = "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
                invalidateVoiceWork()
                turnCoordinator.beginUserTurn(itemID: itemID, text: "写真を共有しました。")
                try sendRealtimeUserItem(observation, itemID: itemID)
            }
            diagnostics.record("voice.camera_snapshot.returned", metadata: ["engine": engine.rawValue])
        } catch {
            diagnostics.record("voice.camera_snapshot.failed", metadata: safeErrorMetadata(error))
            if phase == .thinking { phase = .listening }
            throw error
        }
    }

    public func stop() {
        flushPendingLiveTurn(generation: sessionGeneration)
        sessionGeneration += 1
        sessionLimitTask?.cancel()
        sessionLimitTask = nil
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
        liveDelegationTasks.values.forEach { $0.cancel() }
        liveDelegationTasks.removeAll()
        let activeTransport = transport
        transport = nil
        commitTurn = nil
        performLiveDelegation = nil
        isMuted = false
        isSendingText = false
        textSendErrorMessage = nil
        microphoneLevel = 0
        playbackLevel = 0
        sessionStartedAt = nil
        phase = .idle
        errorMessage = nil
        activeTransport?.close()
        diagnostics.record("realtime.stop")
    }

    func receive(_ data: Data, generation: Int) {
        guard let event = ShannonRealtimeVoiceEvent.decode(data) else { return }
        if case .correlated(let packet) = event {
            receiveCorrelated(packet, generation: generation)
            return
        }
        switch event {
        case .sessionReady:
            markSessionReady()
        case .speechStarted:
            phase = .listening
        case .speechStopped, .responseStarted:
            phase = .thinking
        case .outputTranscriptDelta:
            phase = .speaking
        case .liveInputTranscriptDelta:
            if !liveUserSpeaking {
                invalidateVoiceWork()
                turnCoordinator.beginUserTurn(itemID: UUID().uuidString)
                liveUserSpeaking = true
            }
            phase = .listening
        case .liveOutputTranscriptDelta:
            liveUserSpeaking = false
            phase = .speaking
        case .liveDelegationRequested(let id, _):
            phase = .thinking
            beginLiveDelegation(id: id, generation: generation)
        case .realtimeFunctionCall(let callID, let request):
            phase = .thinking
            beginRealtimeFunctionCall(callID: callID, request: request, generation: generation)
        case .liveUsageUpdated(let seconds):
            liveAudioSeconds = max(liveAudioSeconds, seconds)
        case .liveSessionClosed(let reason):
            flushPendingLiveTurn(generation: generation)
            if reason != "close_requested", phase.keepsSessionActive {
                diagnostics.record("live.session.closed", metadata: ["reason": reason ?? "unknown"])
                fail("音声接続が終了しました。もう一度つなぐと会話を再開できます。")
            }
        case .responseFinished(let responseUsage):
            if let responseUsage { usage.append(responseUsage) }
            if phase != .failed { phase = .listening }
        case .failed(let code):
            if handleRecoverableVoiceError(code) { return }
            diagnostics.record("realtime.event.failed", metadata: ["code": code ?? "unknown"])
            fail("音声接続で問題が起きました。いったん終了して、もう一度お試しください。")
        default:
            break
        }

        if let completed = transcriptState.apply(event) {
            userTranscript = transcriptState.userText
            shannonTranscript = transcriptState.shannonText
            persist(completed, generation: generation)
        } else {
            userTranscript = transcriptState.userText
            shannonTranscript = transcriptState.shannonText
        }
    }

    func markSessionReady() {
        if sessionStartedAt == nil {
            sessionStartedAt = Date()
            scheduleSessionLimit()
        }
        if phase == .connecting { phase = .listening }
    }

    func flushPendingLiveTurn(generation: Int) {
        guard engine == .live, let turn = transcriptState.flushPendingLiveTurn() else { return }
        persist(turn, generation: generation)
    }

    func persist(_ turn: (user: String, shannon: String), generation: Int) {
        guard participantMode.allowsTranscriptPersistence else {
            diagnostics.record("realtime.turn.discarded_for_guest_mode")
            return
        }
        guard let commitTurn else { return }
        Task { @MainActor [weak self] in
            do {
                try await commitTurn(turn.user, turn.shannon)
                guard self?.sessionGeneration == generation else { return }
                self?.diagnostics.record("realtime.turn.persisted")
            } catch {
                guard self?.sessionGeneration == generation else { return }
                self?.diagnostics.record("realtime.turn.persistence_failed", metadata: self?.safeErrorMetadata(error) ?? [:])
                self?.errorMessage = "会話は続けられますが、この一往復を履歴に保存できませんでした。"
            }
        }
    }

    func receiveConnectionState(_ state: ShannonWebRTCConnectionState, generation: Int) {
        switch state {
        case .connected:
            disconnectGraceTask?.cancel()
            disconnectGraceTask = nil
            if phase == .connecting, engine == .realtime { phase = .listening }
            diagnostics.record("realtime.connection.connected")
        case .disconnected:
            scheduleDisconnectFailure(generation: generation)
        case .failed, .closed:
            if phase.keepsSessionActive {
                fail("音声接続が切れました。もう一度つなぎ直してください。")
            }
        case .connecting:
            break
        }
    }

    func scheduleSessionLimit() {
        sessionLimitTask?.cancel()
        sessionLimitTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ShannonRealtimeVoiceBudgetPolicy.maximumSessionDurationSeconds))
            guard !Task.isCancelled else { return }
            self?.fail("10分経過したため、音声会話をいったん終了しました。もう一度つなぐと再開できます。")
        }
    }

    func receiveAudioInterruption(_ event: ShannonRealtimeVoiceInterruptionEvent) {
        switch ShannonRealtimeVoiceRecoveryPolicy.interruptionAction(for: event, phase: phase) {
        case .ignore:
            break
        case .wait:
            phase = .connecting
            diagnostics.record("realtime.audio.interruption_began")
        case .resume:
            phase = sessionStartedAt == nil ? .connecting : .listening
            diagnostics.record("realtime.audio.interruption_resumed")
        case .fail:
            diagnostics.record("realtime.audio.interruption_ended_without_resume")
            fail("ほかの音声利用が終了しました。もう一度つなぐと会話を再開できます。")
        }
    }

    func scheduleDisconnectFailure(generation: Int) {
        guard phase.keepsSessionActive else { return }
        disconnectGraceTask?.cancel()
        phase = .connecting
        diagnostics.record("realtime.connection.disconnected")
        disconnectGraceTask = Task { [weak self] in
            try? await Task.sleep(for: ShannonRealtimeVoiceRecoveryPolicy.disconnectGracePeriod)
            guard !Task.isCancelled, self?.sessionGeneration == generation else { return }
            self?.diagnostics.record("realtime.connection.recovery_timed_out")
            self?.fail("音声接続が切れました。もう一度つなぎ直してください。")
        }
    }

    func fail(_ message: String) {
        flushPendingLiveTurn(generation: sessionGeneration)
        sessionGeneration += 1
        sessionLimitTask?.cancel()
        sessionLimitTask = nil
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
        liveDelegationTasks.values.forEach { $0.cancel() }
        liveDelegationTasks.removeAll()
        let activeTransport = transport
        transport = nil
        commitTurn = nil
        performLiveDelegation = nil
        isMuted = false
        isSendingText = false
        microphoneLevel = 0
        playbackLevel = 0
        sessionStartedAt = nil
        phase = .failed
        errorMessage = message
        activeTransport?.close()
    }

    func safeErrorMetadata(_ error: Error) -> [String: String] {
        let value = error as NSError
        return ["domain": value.domain, "code": String(value.code)]
    }
}

#endif
