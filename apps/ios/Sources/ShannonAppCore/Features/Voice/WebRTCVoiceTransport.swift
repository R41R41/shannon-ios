#if os(iOS) && canImport(WebRTC)
import Foundation
@preconcurrency import AVFoundation
@preconcurrency import WebRTC

enum ShannonWebRTCConnectionState: Sendable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

final class ShannonWebRTCVoiceTransport: NSObject, @unchecked Sendable {
    var onEvent: (@Sendable (Data) -> Void)?
    var onConnectionState: (@Sendable (ShannonWebRTCConnectionState) -> Void)?
    var onAudioInterruption: (@Sendable (ShannonRealtimeVoiceInterruptionEvent) -> Void)?
    var onAudioRouteChange: (@Sendable (Int) -> Void)?
    var onAudioInputStateChange: (@Sendable (ShannonVoiceInputState) -> Void)?
    var onAudioServicesReset: (@Sendable () -> Void)?

    let factory: RTCPeerConnectionFactory
    var peerConnection: RTCPeerConnection?
    var dataChannel: RTCDataChannel?
    var audioTrack: RTCAudioTrack?
    let pitchShiftAudioDevice: ShannonPitchShiftRTCAudioDevice?
    var audioSessionObservers: [NSObjectProtocol] = []
    let iceGatheringEvents: AsyncStream<Void>
    let iceGatheringEventContinuation: AsyncStream<Void>.Continuation
    var inputPreference: ShannonVoiceInputPreference = .automatic

    override init() {
        let iceGatheringEventPair = AsyncStream<Void>.makeStream(
            bufferingPolicy: .bufferingNewest(1)
        )
        iceGatheringEvents = iceGatheringEventPair.stream
        iceGatheringEventContinuation = iceGatheringEventPair.continuation
        RTCInitializeSSL()
        if let profile = ShannonRemoteVoicePitchPolicy.profile(for: .remotePlayout) {
            let audioDevice = ShannonPitchShiftRTCAudioDevice(profile: profile)
            pitchShiftAudioDevice = audioDevice
            factory = RTCPeerConnectionFactory(
                encoderFactory: RTCDefaultVideoEncoderFactory(),
                decoderFactory: RTCDefaultVideoDecoderFactory(),
                audioDevice: audioDevice
            )
        } else {
            pitchShiftAudioDevice = nil
            factory = RTCPeerConnectionFactory()
        }
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

    func setInputPreference(_ preference: ShannonVoiceInputPreference) throws {
        inputPreference = preference
        guard peerConnection != nil else {
            publishAudioInputState()
            return
        }
        try applyInputPreference()
    }

    func send(_ data: Data) throws {
        guard let dataChannel, dataChannel.readyState == .open,
              dataChannel.sendData(RTCDataBuffer(data: data, isBinary: false)) else {
            throw TransportError.eventSendFailed
        }
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

    func configureAudioSession() throws {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try session.setCategory(.playAndRecord, with: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
        try session.setMode(.voiceChat)
        try session.setActive(true)
        session.isAudioEnabled = true
        try applyInputPreference()
    }

    func deactivateAudioSession() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        session.isAudioEnabled = false
        try? session.setActive(false)
        session.unlockForConfiguration()
    }

    func installAudioSessionObservers() {
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
                self?.pitchShiftAudioDevice?.handleInterruption(.began)
                self?.onAudioInterruption?(.began)
            case .ended:
                let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
                let event = ShannonRealtimeVoiceInterruptionEvent.ended(
                    shouldResume: options.contains(.shouldResume)
                )
                self?.pitchShiftAudioDevice?.handleInterruption(event)
                if options.contains(.shouldResume) {
                    try? self?.applyInputPreference()
                }
                self?.onAudioInterruption?(event)
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
            self?.pitchShiftAudioDevice?.handleRouteChange()
            try? self?.applyInputPreference()
            self?.onAudioRouteChange?(Int(reason))
        })
        audioSessionObservers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.pitchShiftAudioDevice?.handleMediaServicesReset()
            self?.onAudioServicesReset?()
        })
    }

    func removeAudioSessionObservers() {
        let center = NotificationCenter.default
        audioSessionObservers.forEach(center.removeObserver)
        audioSessionObservers.removeAll()
    }

    func applyInputPreference() throws {
        let session = AVAudioSession.sharedInstance()
        defer { publishAudioInputState() }
        let inputs = session.availableInputs ?? []
        let selected: AVAudioSessionPortDescription?
        switch inputPreference {
        case .automatic:
            selected = nil
        case .builtIn:
            guard let builtIn = inputs.first(where: { $0.portType == .builtInMic }) else {
                throw TransportError.requestedInputUnavailable
            }
            selected = builtIn
        case .connected:
            guard let connected = inputs.first(where: { $0.portType != .builtInMic }) else {
                throw TransportError.requestedInputUnavailable
            }
            selected = connected
        }
        if session.preferredInput?.uid != selected?.uid {
            try session.setPreferredInput(selected)
        }
    }

    func publishAudioInputState() {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.availableInputs ?? []
        onAudioInputStateChange?(ShannonVoiceInputState(
            preference: inputPreference,
            activeInputName: session.currentRoute.inputs.first?.portName,
            isBuiltInAvailable: inputs.contains(where: { $0.portType == .builtInMic }),
            isConnectedInputAvailable: inputs.contains(where: { $0.portType != .builtInMic })
        ))
    }

    func createOffer(on peer: RTCPeerConnection, constraints: RTCMediaConstraints) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { offer, error in
                if let offer { continuation.resume(returning: offer) }
                else { continuation.resume(throwing: error ?? TransportError.offerFailed) }
            }
        }
    }

    func setLocalDescription(_ value: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(value) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    func setRemoteDescription(_ value: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(value) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    func waitForICEGathering(on peer: RTCPeerConnection) async throws {
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
        case eventSendFailed
        case requestedInputUnavailable
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
#endif
