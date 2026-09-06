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
    case responseFinished
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
        case "response.done": return .responseFinished
        case "error":
            let error = object["error"] as? [String: Any]
            let code = error?["code"] as? String ?? error?["type"] as? String
            return .failed(code)
        default: return nil
        }
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

    private var transport: ShannonWebRTCVoiceTransport?
    private var transcriptState = ShannonRealtimeVoiceTranscriptState()
    private var sessionLimitTask: Task<Void, Never>?
    private var commitTurn: (@MainActor (String, String) async throws -> Void)?
    private let diagnostics = ShannonVoiceDiagnostics.shared

    public init() {}

    public func start(
        createCall: @escaping @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {
        stop()
        phase = .requestingPermission
        errorMessage = nil
        userTranscript = ""
        shannonTranscript = ""
        transcriptState = ShannonRealtimeVoiceTranscriptState()
        diagnostics.record("realtime.start.requested")

        let granted = await AVAudioApplication.requestRecordPermission()
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
            Task { @MainActor in self?.receive(data) }
        }
        transport.onConnectionState = { [weak self] state in
            Task { @MainActor in self?.receiveConnectionState(state) }
        }

        do {
            diagnostics.record("realtime.offer.before")
            let offer = try await transport.createOffer()
            diagnostics.record("realtime.offer.after")
            let call = try await createCall(offer)
            diagnostics.record("realtime.answer.received", metadata: ["model": call.model ?? "unknown"])
            try await transport.acceptAnswer(call.answerSDP)
            sessionStartedAt = Date()
            phase = .listening
            scheduleSessionLimit()
        } catch {
            diagnostics.record("realtime.start.failed", metadata: safeErrorMetadata(error))
            fail("ライブ音声に接続できませんでした。少し待ってもう一度お試しください。")
        }
    }

    public func toggleMute() {
        isMuted.toggle()
        transport?.setMuted(isMuted)
    }

    public func stop() {
        sessionLimitTask?.cancel()
        sessionLimitTask = nil
        transport?.close()
        transport = nil
        commitTurn = nil
        isMuted = false
        sessionStartedAt = nil
        if phase != .failed { phase = .idle }
        diagnostics.record("realtime.stop")
    }

    private func receive(_ data: Data) {
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
        case .responseFinished:
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
            persist(completed)
        } else {
            userTranscript = transcriptState.userText
            shannonTranscript = transcriptState.shannonText
        }
    }

    private func persist(_ turn: (user: String, shannon: String)) {
        guard let commitTurn else { return }
        Task { @MainActor [weak self] in
            do {
                try await commitTurn(turn.user, turn.shannon)
                self?.diagnostics.record("realtime.turn.persisted")
            } catch {
                self?.diagnostics.record("realtime.turn.persistence_failed", metadata: self?.safeErrorMetadata(error) ?? [:])
                self?.errorMessage = "会話は続けられますが、この一往復を履歴に保存できませんでした。"
            }
        }
    }

    private func receiveConnectionState(_ state: ShannonWebRTCConnectionState) {
        switch state {
        case .connected:
            if phase == .connecting { phase = .listening }
        case .failed, .closed:
            if phase != .idle && phase != .failed {
                fail("音声接続が切れました。もう一度つなぎ直してください。")
            }
        case .connecting:
            break
        }
    }

    private func scheduleSessionLimit() {
        sessionLimitTask?.cancel()
        sessionLimitTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10 * 60))
            guard !Task.isCancelled else { return }
            self?.errorMessage = "10分経過したため、音声会話をいったん終了しました。"
            self?.stop()
        }
    }

    private func fail(_ message: String) {
        transport?.close()
        transport = nil
        sessionLimitTask?.cancel()
        phase = .failed
        errorMessage = message
    }

    private func safeErrorMetadata(_ error: Error) -> [String: String] {
        let value = error as NSError
        return ["domain": value.domain, "code": String(value.code)]
    }
}

private enum ShannonWebRTCConnectionState: Sendable {
    case connecting
    case connected
    case failed
    case closed
}

private final class ShannonWebRTCVoiceTransport: NSObject, @unchecked Sendable {
    var onEvent: (@Sendable (Data) -> Void)?
    var onConnectionState: (@Sendable (ShannonWebRTCConnectionState) -> Void)?

    private let factory: RTCPeerConnectionFactory
    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var audioTrack: RTCAudioTrack?

    override init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
        super.init()
    }

    func createOffer() async throws -> String {
        try configureAudioSession()
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherContinually
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
        try session.setCategory(.playAndRecord, with: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
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

    private enum TransportError: Error {
        case peerCreationFailed
        case dataChannelCreationFailed
        case offerFailed
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
        case .failed, .disconnected: onConnectionState?(.failed)
        case .closed: onConnectionState?(.closed)
        case .count: break
        @unknown default: break
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
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
                    } else if let error = model.errorMessage {
                        Text(error)
                            .font(.callout)
                            .foregroundStyle(palette.error)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, M3Spacing.large)
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
            Button { model.toggleMute() } label: {
                Image(systemName: model.isMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.title3)
                    .frame(width: 52, height: 52)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isMuted ? "ミュートを解除" : "ミュート")

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
