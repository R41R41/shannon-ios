import Foundation
import Observation
import SwiftUI

public enum ShannonRealtimeVoicePhase: Equatable, Sendable {
    case idle
    case requestingPermission
    case connecting
    case listening
    case thinking
    case speaking
    case failed

    public var japaneseLabel: String {
        switch self {
        case .idle: "音声で話す"
        case .requestingPermission: "マイクを準備中"
        case .connecting: "シャノンにつないでいる…"
        case .listening: "聞いている"
        case .thinking: "考えている"
        case .speaking: "話している"
        case .failed: "接続できませんでした"
        }
    }

    var keepsSessionActive: Bool {
        switch self {
        case .requestingPermission, .connecting, .listening, .thinking, .speaking:
            true
        case .idle, .failed:
            false
        }
    }
}

public enum ShannonRealtimeVoiceRecoveryPolicy {
    public static let disconnectGracePeriod: Duration = .seconds(5)

    public static func interruptionAction(
        for event: ShannonRealtimeVoiceInterruptionEvent,
        phase: ShannonRealtimeVoicePhase
    ) -> ShannonRealtimeVoiceInterruptionAction {
        guard phase.keepsSessionActive else { return .ignore }
        switch event {
        case .began:
            return .wait
        case .ended(shouldResume: true):
            return .resume
        case .ended(shouldResume: false):
            return .fail
        }
    }
}

public enum ShannonRealtimeVoiceInterruptionEvent: Equatable, Sendable {
    case began
    case ended(shouldResume: Bool)
}

public enum ShannonRealtimeVoiceInterruptionAction: Equatable, Sendable {
    case ignore
    case wait
    case resume
    case fail
}

public struct ShannonRealtimeVoiceUsage: Equatable, Sendable {
    public private(set) var totalTokens: Int
    public private(set) var inputTokens: Int
    public private(set) var outputTokens: Int
    public private(set) var cachedInputTokens: Int
    public private(set) var inputAudioTokens: Int
    public private(set) var outputAudioTokens: Int

    public static let zero = ShannonRealtimeVoiceUsage()

    public init(
        totalTokens: Int = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cachedInputTokens: Int = 0,
        inputAudioTokens: Int = 0,
        outputAudioTokens: Int = 0
    ) {
        self.totalTokens = max(0, totalTokens)
        self.inputTokens = max(0, inputTokens)
        self.outputTokens = max(0, outputTokens)
        self.cachedInputTokens = max(0, cachedInputTokens)
        self.inputAudioTokens = max(0, inputAudioTokens)
        self.outputAudioTokens = max(0, outputAudioTokens)
    }

    public mutating func append(_ value: ShannonRealtimeVoiceUsage) {
        totalTokens += value.totalTokens
        inputTokens += value.inputTokens
        outputTokens += value.outputTokens
        cachedInputTokens += value.cachedInputTokens
        inputAudioTokens += value.inputAudioTokens
        outputAudioTokens += value.outputAudioTokens
    }
}

public enum ShannonRealtimeVoiceBudgetPolicy {
    public static let maximumSessionDurationSeconds = 10 * 60

    public static func remainingSeconds(startedAt: Date, now: Date) -> Int {
        let elapsed = max(0, Int(now.timeIntervalSince(startedAt)))
        return max(0, maximumSessionDurationSeconds - elapsed)
    }

    public static func remainingLabel(startedAt: Date, now: Date) -> String {
        let seconds = remainingSeconds(startedAt: startedAt, now: now)
        return String(format: "残り %02d:%02d", seconds / 60, seconds % 60)
    }
}

public enum ShannonRealtimeVoiceEvent: Equatable, Sendable {
    case sessionReady
    case speechStarted
    case speechStopped
    case inputTranscriptDelta(String)
    case inputTranscriptDone(String)
    case outputTranscriptDelta(String)
    case outputTranscriptDone(String)
    case responseStarted
    case responseFinished(ShannonRealtimeVoiceUsage?)
    case failed(String?)

    public static func decode(_ data: Data) -> Self? {
        guard let value = try? JSONSerialization.jsonObject(with: data),
              let object = value as? [String: Any],
              let type = object["type"] as? String else { return nil }
        switch type {
        case "session.created", "session.updated": return .sessionReady
        case "input_audio_buffer.speech_started": return .speechStarted
        case "input_audio_buffer.speech_stopped": return .speechStopped
        case "conversation.item.input_audio_transcription.delta":
            return .inputTranscriptDelta(object["delta"] as? String ?? "")
        case "conversation.item.input_audio_transcription.completed":
            return .inputTranscriptDone(object["transcript"] as? String ?? "")
        case "response.output_audio_transcript.delta", "response.audio_transcript.delta":
            return .outputTranscriptDelta(object["delta"] as? String ?? "")
        case "response.output_audio_transcript.done", "response.audio_transcript.done":
            return .outputTranscriptDone(object["transcript"] as? String ?? "")
        case "response.created": return .responseStarted
        case "response.done":
            let response = object["response"] as? [String: Any]
            return .responseFinished(decodeUsage(response?["usage"]))
        case "error":
            let error = object["error"] as? [String: Any]
            let code = error?["code"] as? String ?? error?["type"] as? String
            return .failed(code)
        default: return nil
        }
    }

    private static func decodeUsage(_ value: Any?) -> ShannonRealtimeVoiceUsage? {
        guard let usage = value as? [String: Any] else { return nil }
        let inputDetails = usage["input_token_details"] as? [String: Any]
        let outputDetails = usage["output_token_details"] as? [String: Any]
        return ShannonRealtimeVoiceUsage(
            totalTokens: usage["total_tokens"] as? Int ?? 0,
            inputTokens: usage["input_tokens"] as? Int ?? 0,
            outputTokens: usage["output_tokens"] as? Int ?? 0,
            cachedInputTokens: inputDetails?["cached_tokens"] as? Int ?? 0,
            inputAudioTokens: inputDetails?["audio_tokens"] as? Int ?? 0,
            outputAudioTokens: outputDetails?["audio_tokens"] as? Int ?? 0
        )
    }
}

public struct ShannonRealtimeVoiceTranscriptState: Equatable, Sendable {
    public private(set) var userText = ""
    public private(set) var shannonText = ""
    private var completedUserText = ""
    private var completedShannonText = ""

    public init() {}

    public mutating func apply(_ event: ShannonRealtimeVoiceEvent) -> (user: String, shannon: String)? {
        switch event {
        case .speechStarted:
            userText = ""
            completedUserText = ""
            shannonText = ""
            completedShannonText = ""
        case .inputTranscriptDelta(let delta):
            userText += delta
        case .inputTranscriptDone(let transcript):
            completedUserText = normalized(transcript, fallback: userText)
            userText = completedUserText
        case .outputTranscriptDelta(let delta):
            shannonText += delta
        case .outputTranscriptDone(let transcript):
            completedShannonText = normalized(transcript, fallback: shannonText)
            shannonText = completedShannonText
        default:
            break
        }
        guard !completedUserText.isEmpty, !completedShannonText.isEmpty else { return nil }
        let turn = (completedUserText, completedShannonText)
        completedUserText = ""
        completedShannonText = ""
        return turn
    }

    private func normalized(_ value: String, fallback: String) -> String {
        let preferred = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return preferred.isEmpty ? fallback.trimmingCharacters(in: .whitespacesAndNewlines) : preferred
    }
}

public struct ShannonRealtimeOfferDiagnostics: Equatable, Sendable {
    public let byteCount: Int
    public let audioSectionCount: Int
    public let dataSectionCount: Int
    public let candidateCount: Int

    public init(sdp: String) {
        byteCount = sdp.utf8.count
        let lines = sdp.split(whereSeparator: \.isNewline)
        audioSectionCount = lines.count { $0.hasPrefix("m=audio ") }
        dataSectionCount = lines.count { $0.hasPrefix("m=application ") }
        candidateCount = lines.count { $0.hasPrefix("a=candidate:") }
    }

    public var metadata: [String: String] {
        [
            "bytes": String(byteCount),
            "audio_sections": String(audioSectionCount),
            "data_sections": String(dataSectionCount),
            "candidates": String(candidateCount),
            "ice_gathering": "complete",
        ]
    }
}

#if os(iOS) && canImport(WebRTC)
@preconcurrency import AVFoundation
@preconcurrency import WebRTC

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

    private var transport: ShannonWebRTCVoiceTransport?
    private var transcriptState = ShannonRealtimeVoiceTranscriptState()
    private var sessionLimitTask: Task<Void, Never>?
    private var disconnectGraceTask: Task<Void, Never>?
    private var commitTurn: (@MainActor (String, String) async throws -> Void)?
    private var sessionGeneration = 0
    private let diagnostics = ShannonVoiceDiagnostics.shared

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
            fail("ライブ音声に接続できませんでした。少し待ってもう一度お試しください。")
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

    private func receive(_ data: Data, generation: Int) {
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

    private func persist(_ turn: (user: String, shannon: String), generation: Int) {
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

    private func receiveConnectionState(_ state: ShannonWebRTCConnectionState, generation: Int) {
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

    private func scheduleSessionLimit() {
        sessionLimitTask?.cancel()
        sessionLimitTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ShannonRealtimeVoiceBudgetPolicy.maximumSessionDurationSeconds))
            guard !Task.isCancelled else { return }
            self?.fail("10分経過したため、音声会話をいったん終了しました。もう一度つなぐと再開できます。")
        }
    }

    private func receiveAudioInterruption(_ event: ShannonRealtimeVoiceInterruptionEvent) {
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

    private func scheduleDisconnectFailure(generation: Int) {
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

    private func fail(_ message: String) {
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

    private func safeErrorMetadata(_ error: Error) -> [String: String] {
        let value = error as NSError
        return ["domain": value.domain, "code": String(value.code)]
    }
}

private enum ShannonWebRTCConnectionState: Sendable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

private final class ShannonWebRTCVoiceTransport: NSObject, @unchecked Sendable {
    var onEvent: (@Sendable (Data) -> Void)?
    var onConnectionState: (@Sendable (ShannonWebRTCConnectionState) -> Void)?
    var onAudioInterruption: (@Sendable (ShannonRealtimeVoiceInterruptionEvent) -> Void)?
    var onAudioRouteChange: (@Sendable (Int) -> Void)?
    var onAudioServicesReset: (@Sendable () -> Void)?

    private let factory: RTCPeerConnectionFactory
    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var audioTrack: RTCAudioTrack?
    private var audioSessionObservers: [NSObjectProtocol] = []
    private let iceGatheringEvents: AsyncStream<Void>
    private let iceGatheringEventContinuation: AsyncStream<Void>.Continuation

    override init() {
        let iceGatheringEventPair = AsyncStream<Void>.makeStream(
            bufferingPolicy: .bufferingNewest(1)
        )
        iceGatheringEvents = iceGatheringEventPair.stream
        iceGatheringEventContinuation = iceGatheringEventPair.continuation
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
        super.init()
        installAudioSessionObservers()
    }

    deinit {
        removeAudioSessionObservers()
    }

    func createOffer() async throws -> String {
        try configureAudioSession()
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        // OpenAI's one-shot SDP exchange cannot receive candidates discovered
        // after the offer is posted, so gather once and wait for completion.
        configuration.continualGatheringPolicy = .gatherOnce
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )
        guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw TransportError.peerCreationFailed
        }
        peerConnection = peer

        let audioConstraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: [
                "googEchoCancellation": "true",
                "googAutoGainControl": "true",
                "googNoiseSuppression": "true",
                "googHighpassFilter": "true",
            ]
        )
        let source = factory.audioSource(with: audioConstraints)
        let track = factory.audioTrack(with: source, trackId: "shannon-audio")
        peer.add(track, streamIds: ["shannon-stream"])
        audioTrack = track

        let channelConfiguration = RTCDataChannelConfiguration()
        guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration) else {
            throw TransportError.dataChannelCreationFailed
        }
        channel.delegate = self
        dataChannel = channel

        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: [
                kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueTrue,
                kRTCMediaConstraintsOfferToReceiveVideo: kRTCMediaConstraintsValueFalse,
            ],
            optionalConstraints: nil
        )
        let offer = try await createOffer(on: peer, constraints: offerConstraints)
        try await setLocalDescription(offer, on: peer)
        try await waitForICEGathering(on: peer)
        return peer.localDescription?.sdp ?? offer.sdp
    }

    func acceptAnswer(_ answerSDP: String) async throws {
        guard let peerConnection else { throw TransportError.peerCreationFailed }
        try await setRemoteDescription(
            RTCSessionDescription(type: .answer, sdp: answerSDP),
            on: peerConnection
        )
    }

    func setMuted(_ muted: Bool) {
        audioTrack?.isEnabled = !muted
    }

    func close() {
        removeAudioSessionObservers()
        iceGatheringEventContinuation.finish()
        audioTrack?.isEnabled = false
        dataChannel?.delegate = nil
        dataChannel?.close()
        peerConnection?.close()
        dataChannel = nil
        peerConnection = nil
        audioTrack = nil
        deactivateAudioSession()
    }

    private func configureAudioSession() throws {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try session.setCategory(.playAndRecord, with: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
        try session.setMode(.voiceChat)
        try session.setActive(true)
        session.isAudioEnabled = true
    }

    private func deactivateAudioSession() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        session.isAudioEnabled = false
        try? session.setActive(false)
        session.unlockForConfiguration()
    }

    private func installAudioSessionObservers() {
        let center = NotificationCenter.default
        audioSessionObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
            switch type {
            case .began:
                self?.onAudioInterruption?(.began)
            case .ended:
                let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
                self?.onAudioInterruption?(.ended(shouldResume: options.contains(.shouldResume)))
            @unknown default:
                break
            }
        })
        audioSessionObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            self?.onAudioRouteChange?(Int(reason))
        })
        audioSessionObservers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.onAudioServicesReset?()
        })
    }

    private func removeAudioSessionObservers() {
        let center = NotificationCenter.default
        audioSessionObservers.forEach(center.removeObserver)
        audioSessionObservers.removeAll()
    }

    private func createOffer(on peer: RTCPeerConnection, constraints: RTCMediaConstraints) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { offer, error in
                if let offer { continuation.resume(returning: offer) }
                else { continuation.resume(throwing: error ?? TransportError.offerFailed) }
            }
        }
    }

    private func setLocalDescription(_ value: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(value) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func setRemoteDescription(_ value: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(value) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func waitForICEGathering(on peer: RTCPeerConnection) async throws {
        guard peer.iceGatheringState != .complete else { return }
        let events = iceGatheringEvents
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                for await _ in events { return }
                throw TransportError.iceGatheringCancelled
            }
            group.addTask {
                try await Task.sleep(for: .seconds(10))
                throw TransportError.iceGatheringTimedOut
            }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    private enum TransportError: Error {
        case peerCreationFailed
        case dataChannelCreationFailed
        case offerFailed
        case iceGatheringCancelled
        case iceGatheringTimedOut
    }
}

extension ShannonWebRTCVoiceTransport: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        switch newState {
        case .new, .checking: onConnectionState?(.connecting)
        case .connected, .completed: onConnectionState?(.connected)
        case .disconnected: onConnectionState?(.disconnected)
        case .failed: onConnectionState?(.failed)
        case .closed: onConnectionState?(.closed)
        case .count: break
        @unknown default: break
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete {
            iceGatheringEventContinuation.yield(())
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        self.dataChannel = dataChannel
        dataChannel.delegate = self
    }
}

extension ShannonWebRTCVoiceTransport: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        onEvent?(buffer.data)
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
    public init() {}
    public func start(
        createCall: @escaping @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {}
    public func toggleMute() {}
    public func stop() { phase = .idle }
}
#endif

public struct ShannonLiveVoiceView: View {
    @Bindable private var model: ShannonRealtimeVoiceSessionModel
    private let expression: ShannonExpressionDTO
    private let createCall: @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO
    private let commitTurn: @MainActor (String, String) async throws -> Void
    private let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var didStart = false
    @State private var pulse = false

    public init(
        model: ShannonRealtimeVoiceSessionModel,
        expression: ShannonExpressionDTO,
        createCall: @escaping @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void,
        dismiss: @escaping () -> Void
    ) {
        self.model = model
        self.expression = expression
        self.createCall = createCall
        self.commitTurn = commitTurn
        self.dismiss = dismiss
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        ZStack {
            LinearGradient(
                colors: [palette.surface, palette.primaryContainer.opacity(0.72), palette.surface],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(palette.primary.opacity(phaseGlowOpacity))
                .frame(width: 330, height: 330)
                .scaleEffect(pulse && !reduceMotion ? 1.08 : 0.94)
                .blur(radius: 36)
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: model.phase == .speaking ? 0.8 : 1.7).repeatForever(autoreverses: true),
                    value: pulse
                )

            VStack(spacing: 0) {
                topBar(palette)
                Spacer(minLength: 12)

                ZStack(alignment: .bottom) {
                    ShannonDialogueStagePortraitView()
                        .frame(maxWidth: 440)
                        .scaleEffect(pulse && model.phase == .speaking && !reduceMotion ? 1.015 : 1)

                    if !model.shannonTranscript.isEmpty {
                        transcriptCard(
                            speaker: "シャノン",
                            text: model.shannonTranscript,
                            alignment: .leading,
                            palette: palette
                        )
                        .padding(.horizontal, M3Spacing.large)
                        .padding(.bottom, M3Spacing.large)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                .frame(maxHeight: .infinity)

                VStack(spacing: M3Spacing.medium) {
                    if !model.userTranscript.isEmpty {
                        transcriptCard(
                            speaker: "あなた",
                            text: model.userTranscript,
                            alignment: .trailing,
                            palette: palette
                        )
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    if let error = model.errorMessage {
                        Text(error)
                            .font(.callout)
                            .foregroundStyle(palette.error)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, M3Spacing.large)
                    }

                    if let startedAt = model.sessionStartedAt {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            HStack(spacing: M3Spacing.medium) {
                                Label(
                                    ShannonRealtimeVoiceBudgetPolicy.remainingLabel(
                                        startedAt: startedAt,
                                        now: context.date
                                    ),
                                    systemImage: "clock"
                                )
                                if model.usage.totalTokens > 0 {
                                    Label(
                                        "\(model.usage.totalTokens.formatted()) トークン",
                                        systemImage: "waveform.badge.magnifyingglass"
                                    )
                                }
                            }
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(palette.onSurfaceVariant)
                            .accessibilityElement(children: .combine)
                        }
                    }

                    controls(palette)
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.bottom, M3Spacing.large)
            }
        }
        .foregroundStyle(palette.onSurface)
        .task {
            guard !didStart else { return }
            didStart = true
            pulse = true
            await model.start(createCall: createCall, commitTurn: commitTurn)
        }
        .onDisappear { model.stop() }
    }

    private func topBar(_ palette: M3Palette) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("シャノン")
                    .font(.headline)
                Text(model.phase.japaneseLabel)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()
            Button {
                model.stop()
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声会話を閉じる")
        }
        .padding(.horizontal, M3Spacing.large)
        .padding(.top, M3Spacing.small)
    }

    private func transcriptCard(
        speaker: String,
        text: String,
        alignment: Alignment,
        palette: M3Palette
    ) -> some View {
        VStack(alignment: alignment == .leading ? .leading : .trailing, spacing: 4) {
            Text(speaker)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(palette.onSurfaceVariant)
            Text(text)
                .font(.body)
                .lineSpacing(2)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: alignment)
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.vertical, M3Spacing.small)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
                .stroke(palette.outlineVariant.opacity(0.7), lineWidth: 0.7)
        }
    }

    private func controls(_ palette: M3Palette) -> some View {
        HStack(spacing: M3Spacing.large) {
            if model.phase == .failed {
                Button {
                    Task {
                        await model.start(createCall: createCall, commitTurn: commitTurn)
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.title3)
                        .frame(width: 52, height: 52)
                        .background(.thinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("もう一度つなぐ")
            } else {
                Button { model.toggleMute() } label: {
                    Image(systemName: model.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.title3)
                        .frame(width: 52, height: 52)
                        .background(.thinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.isMuted ? "ミュートを解除" : "ミュート")
            }

            Button {
                model.stop()
                dismiss()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 64, height: 64)
                    .background(Color.red.opacity(0.88), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声会話を終了")

            ZStack {
                Circle().fill(.thinMaterial)
                Image(systemName: phaseSymbol)
                    .font(.title3)
                    .foregroundStyle(palette.primary)
            }
            .frame(width: 52, height: 52)
            .accessibilityHidden(true)
        }
    }

    private var phaseSymbol: String {
        switch model.phase {
        case .idle: "waveform"
        case .requestingPermission, .connecting: "ellipsis"
        case .listening: "ear.fill"
        case .thinking: "sparkles"
        case .speaking: "waveform.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private var phaseGlowOpacity: Double {
        switch model.phase {
        case .speaking: 0.22
        case .listening: 0.14
        case .thinking, .connecting, .requestingPermission: 0.10
        case .idle, .failed: 0.06
        }
    }
}
