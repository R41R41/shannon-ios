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
    var onAudioServicesReset: (@Sendable () -> Void)?

    let factory: RTCPeerConnectionFactory
    var peerConnection: RTCPeerConnection?
    var dataChannel: RTCDataChannel?
    var audioTrack: RTCAudioTrack?
    var audioSessionObservers: [NSObjectProtocol] = []
    let iceGatheringEvents: AsyncStream<Void>
    let iceGatheringEventContinuation: AsyncStream<Void>.Continuation

    override init() {
        let iceGatheringEventPair = AsyncStream<Void>.makeStream(
            bufferingPolicy: .bufferingNewest(1)
        )
        iceGatheringEvents = iceGatheringEventPair.stream
        iceGatheringEventContinuation = iceGatheringEventPair.continuation
        RTCInitializeSSL()
        #if DEBUG
        let livePreset = ShannonVoiceLabLiveSettings.preset
        if livePreset.kind == .appleTimePitch {
            factory = RTCPeerConnectionFactory(
                encoderFactory: RTCDefaultVideoEncoderFactory(),
                decoderFactory: RTCDefaultVideoDecoderFactory(),
                audioDevice: ShannonVoiceLabRTCAudioDevice(preset: livePreset)
            )
        } else {
            factory = RTCPeerConnectionFactory()
        }
        #else
        factory = RTCPeerConnectionFactory()
        #endif
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

    func removeAudioSessionObservers() {
        let center = NotificationCenter.default
        audioSessionObservers.forEach(center.removeObserver)
        audioSessionObservers.removeAll()
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
#if DEBUG
/// Debug-only WebRTC audio device which inserts Apple audio units in remote
/// playout while leaving the data channel and session state machine unchanged.
final class ShannonVoiceLabRTCAudioDevice: NSObject, RTCAudioDevice, @unchecked Sendable {
    private let preset: ShannonVoiceLabPreset
    private let session = AVAudioSession.sharedInstance()
    private let lock = NSLock()
    private var delegateStorage: RTCAudioDeviceDelegate?
    private var engine: AVAudioEngine?
    private var sourceNode: AVAudioSourceNode?
    private var sinkNode: AVAudioSinkNode?
    private var recorderConverter: ShannonVoiceLabAudioConverter?
    private var shouldPlay = false
    private var shouldRecord = false
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    init(preset: ShannonVoiceLabPreset) { self.preset = preset; super.init() }
    private var delegate: RTCAudioDeviceDelegate? {
        get { lock.withLock { delegateStorage } }
        set { lock.withLock { delegateStorage = newValue } }
    }
    var deviceInputSampleRate: Double { inputFormat?.sampleRate ?? session.sampleRate }
    var inputIOBufferDuration: TimeInterval { session.ioBufferDuration }
    var inputNumberOfChannels: Int { Int(inputFormat?.channelCount ?? 1) }
    var inputLatency: TimeInterval { session.inputLatency }
    var deviceOutputSampleRate: Double { outputFormat?.sampleRate ?? session.sampleRate }
    var outputIOBufferDuration: TimeInterval { session.ioBufferDuration }
    var outputNumberOfChannels: Int { Int(outputFormat?.channelCount ?? 1) }
    var outputLatency: TimeInterval { session.outputLatency }
    var isInitialized: Bool { delegate != nil }
    var isPlayoutInitialized: Bool { isInitialized }
    var isRecordingInitialized: Bool { isInitialized }
    var isPlaying: Bool { shouldPlay }
    var isRecording: Bool { shouldRecord }
    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        guard self.delegate == nil else { return false }
        self.delegate = delegate
        return true
    }
    func terminateDevice() -> Bool {
        shouldPlay = false
        shouldRecord = false
        shutdownEngine()
        delegate = nil
        return true
    }
    func initializePlayout() -> Bool { isPlayoutInitialized }
    func initializeRecording() -> Bool { isRecordingInitialized }
    func startPlayout() -> Bool { shouldPlay = true; return updateEngine() }
    func stopPlayout() -> Bool { shouldPlay = false; return updateEngine() }
    func startRecording() -> Bool { shouldRecord = true; return updateEngine() }
    func stopRecording() -> Bool { shouldRecord = false; return updateEngine() }
    private func updateEngine() -> Bool {
        guard let delegate, shouldPlay || shouldRecord else {
            shutdownEngine()
            return true
        }
        shutdownEngine()
        let engine = AVAudioEngine()
        do {
            if !engine.outputNode.isVoiceProcessingEnabled {
                try engine.outputNode.setVoiceProcessingEnabled(true)
            }
        } catch {
            return false
        }
        if shouldRecord, !configureRecording(engine: engine, delegate: delegate) {
            return false
        }
        if shouldPlay, !configurePlayout(engine: engine, delegate: delegate) {
            return false
        }
        engine.prepare()
        do {
            try engine.start()
            self.engine = engine
            return true
        } catch {
            shutdownEngine(engine)
            return false
        }
    }
    private func configureRecording(
        engine: AVAudioEngine,
        delegate: RTCAudioDeviceDelegate
    ) -> Bool {
        let nativeFormat = engine.inputNode.outputFormat(forBus: 1)
        guard nativeFormat.sampleRate > 0, nativeFormat.channelCount > 0,
              let rtcFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: nativeFormat.sampleRate,
                channels: nativeFormat.channelCount,
                interleaved: true
              ),
              let converter = ShannonVoiceLabAudioConverter(from: nativeFormat, to: rtcFormat) else {
            return false
        }
        let deliver = delegate.deliverRecordedData
        let render: RTCAudioDeviceRenderRecordedDataBlock = {
            _, _, _, frameCount, outputData, context in
            guard let context else { return kAudio_ParamError }
            let values = context.assumingMemoryBound(
                to: (Unmanaged<ShannonVoiceLabAudioConverter>, UnsafePointer<AudioBufferList>).self
            ).pointee
            return values.0.takeUnretainedValue().convert(
                frameCount: frameCount,
                from: values.1,
                to: outputData
            )
        }
        let sink = AVAudioSinkNode { timestamp, frameCount, inputData in
            var flags: AudioUnitRenderActionFlags = []
            var context = (Unmanaged.passUnretained(converter), UnsafePointer(inputData))
            return deliver(&flags, timestamp, 1, frameCount, nil, &context, render)
        }
        engine.attach(sink)
        engine.connect(engine.inputNode, to: sink, format: nativeFormat)
        inputFormat = rtcFormat
        recorderConverter = converter
        sinkNode = sink
        return true
    }
    private func configurePlayout(
        engine: AVAudioEngine,
        delegate: RTCAudioDeviceDelegate
    ) -> Bool {
        let nativeFormat = engine.outputNode.outputFormat(forBus: 0)
        guard nativeFormat.sampleRate > 0, nativeFormat.channelCount > 0,
              let rtcFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: nativeFormat.sampleRate,
                channels: nativeFormat.channelCount,
                interleaved: true
              ) else {
            return false
        }
        let getPlayoutData = delegate.getPlayoutData
        let source = AVAudioSourceNode(format: rtcFormat) {
            isSilence, timestamp, frameCount, outputData in
            var flags: AudioUnitRenderActionFlags = []
            let status = getPlayoutData(&flags, timestamp, 0, frameCount, outputData)
            isSilence.pointee = ObjCBool(flags.contains(.unitRenderAction_OutputIsSilence))
            return status
        }
        let converterMixer = AVAudioMixerNode()
        let timePitch = AVAudioUnitTimePitch()
        let equalizer = AVAudioUnitEQ(numberOfBands: 2)
        configure(equalizer: equalizer)
        timePitch.pitch = preset.pitchCents
        timePitch.rate = preset.rate
        equalizer.globalGain = preset.outputGainDB
        engine.attach(source)
        engine.attach(converterMixer)
        engine.attach(timePitch)
        engine.attach(equalizer)
        engine.connect(source, to: converterMixer, format: rtcFormat)
        engine.connect(converterMixer, to: timePitch, format: nativeFormat)
        engine.connect(timePitch, to: equalizer, format: nativeFormat)
        engine.connect(equalizer, to: engine.mainMixerNode, format: nativeFormat)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nativeFormat)
        outputFormat = rtcFormat
        sourceNode = source
        return true
    }
    private func configure(equalizer: AVAudioUnitEQ) {
        let high = equalizer.bands[0]
        high.filterType = .highShelf
        high.frequency = 3_200
        high.bandwidth = 0.7
        high.gain = 1.2
        high.bypass = false
        let low = equalizer.bands[1]
        low.filterType = .lowShelf
        low.frequency = 180
        low.bandwidth = 0.7
        low.gain = -0.8
        low.bypass = false
    }
    private func shutdownEngine(_ specificEngine: AVAudioEngine? = nil) {
        let target = specificEngine ?? engine
        target?.stop()
        target?.reset()
        if specificEngine == nil {
            engine = nil
            sourceNode = nil
            sinkNode = nil
            recorderConverter = nil
        }
    }
}
private final class ShannonVoiceLabAudioConverter: @unchecked Sendable {
    private var converter: AudioConverterRef?
    init?(from: AVAudioFormat, to: AVAudioFormat) {
        guard from.sampleRate == to.sampleRate,
              AudioConverterNew(from.streamDescription, to.streamDescription, &converter) == noErr else {
            return nil
        }
    }
    deinit {
        if let converter { AudioConverterDispose(converter) }
    }
    func convert(
        frameCount: AVAudioFrameCount,
        from: UnsafePointer<AudioBufferList>,
        to: UnsafeMutablePointer<AudioBufferList>
    ) -> OSStatus {
        guard let converter else { return kAudio_ParamError }
        return AudioConverterConvertComplexBuffer(converter, frameCount, from, to)
    }
}
#endif
#endif
