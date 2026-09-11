import Foundation
import Observation

#if os(iOS) && canImport(WebRTC)
@preconcurrency import AVFoundation

@MainActor
@Observable
public final class ShannonRealtimeVoiceSessionModel {
    public private(set) var phase: ShannonRealtimeVoicePhase = .idle
    public private(set) var userTranscript = ""
    public private(set) var shannonTranscript = ""
    public private(set) var errorMessage: String?
    public private(set) var isMuted = false
    public private(set) var sessionStartedAt: Date?
    public private(set) var usage = ShannonRealtimeVoiceUsage.zero
    public private(set) var dailyRemainingSeconds: Int?

    var transport: ShannonWebRTCVoiceTransport?
    var transcriptState = ShannonRealtimeVoiceTranscriptState()
    var sessionLimitTask: Task<Void, Never>?
    var disconnectGraceTask: Task<Void, Never>?
    var commitTurn: (@MainActor (String, String) async throws -> Void)?
    var sessionGeneration = 0
    let diagnostics = ShannonVoiceDiagnostics.shared

    public init() {}

    public func start(
        createCall: @escaping @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {
        stop()
        sessionGeneration += 1
        let generation = sessionGeneration
        phase = .requestingPermission
        errorMessage = nil
        userTranscript = ""
        shannonTranscript = ""
        transcriptState = ShannonRealtimeVoiceTranscriptState()
        usage = .zero
        dailyRemainingSeconds = nil
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
        transport.onAudioRouteChange = { [weak self] reason in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.diagnostics.record(
                    "realtime.audio.route_changed",
                    metadata: ["reason": String(reason)]
                )
            }
        }
        transport.onAudioServicesReset = { [weak self] in
            Task { @MainActor in
                guard self?.sessionGeneration == generation else { return }
                self?.diagnostics.record("realtime.audio.services_reset")
                self?.fail("iPhoneの音声機能が再起動されました。もう一度つなぐと再開できます。")
            }
        }

        do {
            diagnostics.record("realtime.offer.before")
            let offer = try await transport.createOffer()
            diagnostics.record(
                "realtime.offer.after",
                metadata: ShannonRealtimeOfferDiagnostics(sdp: offer).metadata
            )
            let call = try await createCall(offer)
            guard generation == sessionGeneration else {
                transport.close()
                return
            }
            diagnostics.record("realtime.answer.received", metadata: ["model": call.model ?? "unknown"])
            dailyRemainingSeconds = call.dailyRemainingSeconds
            try await transport.acceptAnswer(call.answerSDP)
            guard generation == sessionGeneration else {
                transport.close()
                return
            }
            sessionStartedAt = Date()
            phase = .listening
            scheduleSessionLimit()
        } catch {
            guard generation == sessionGeneration else { return }
            diagnostics.record("realtime.start.failed", metadata: safeErrorMetadata(error))
            fail(ShannonRealtimeVoiceFailurePresentation.startMessage(for: error))
        }
    }

    public func toggleMute() {
        isMuted.toggle()
        transport?.setMuted(isMuted)
    }

    public func stop() {
        sessionGeneration += 1
        sessionLimitTask?.cancel()
        sessionLimitTask = nil
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
        let activeTransport = transport
        transport = nil
        commitTurn = nil
        isMuted = false
        sessionStartedAt = nil
        phase = .idle
        errorMessage = nil
        activeTransport?.close()
        diagnostics.record("realtime.stop")
    }

    func receive(_ data: Data, generation: Int) {
        guard let event = ShannonRealtimeVoiceEvent.decode(data) else { return }
        switch event {
        case .sessionReady:
            if phase == .connecting { phase = .listening }
        case .speechStarted:
            phase = .listening
        case .speechStopped, .responseStarted:
            phase = .thinking
        case .outputTranscriptDelta:
            phase = .speaking
        case .responseFinished(let responseUsage):
            if let responseUsage { usage.append(responseUsage) }
            if phase != .failed { phase = .listening }
        case .failed(let code):
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

    func persist(_ turn: (user: String, shannon: String), generation: Int) {
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
            if phase == .connecting { phase = .listening }
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
        sessionGeneration += 1
        sessionLimitTask?.cancel()
        sessionLimitTask = nil
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
        let activeTransport = transport
        transport = nil
        commitTurn = nil
        isMuted = false
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
#else
@MainActor
@Observable
public final class ShannonRealtimeVoiceSessionModel {
    public private(set) var phase: ShannonRealtimeVoicePhase = .failed
    public private(set) var userTranscript = ""
    public private(set) var shannonTranscript = ""
    public private(set) var errorMessage: String? = "ライブ音声はiPhoneで利用できます。"
    public private(set) var isMuted = false
    public private(set) var sessionStartedAt: Date?
    public private(set) var usage = ShannonRealtimeVoiceUsage.zero
    public private(set) var dailyRemainingSeconds: Int?
    public init() {}
    public func start(
        createCall: @escaping @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {}
    public func toggleMute() {}
    public func stop() { phase = .idle }
}
#endif
