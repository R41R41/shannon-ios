#if os(iOS) && canImport(WebRTC)
import Foundation
@preconcurrency import AVFoundation
@preconcurrency import WebRTC

/// WebRTC audio device that raises remote playout while forwarding microphone
/// PCM unchanged. Voice Processing I/O remains responsible for echo control.
final class ShannonPitchShiftRTCAudioDevice: NSObject, RTCAudioDevice, @unchecked Sendable {
    private let profile: ShannonRemoteVoicePitchProfile
    private let session = AVAudioSession.sharedInstance()
    private let lock = NSLock()

    private var delegateStorage: RTCAudioDeviceDelegate?
    private var engine: AVAudioEngine?
    private var engineConfigurationObserver: NSObjectProtocol?
    private var sourceNode: AVAudioSourceNode?
    private var sinkNode: AVAudioSinkNode?
    private var recordingMixerNode: AVAudioMixerNode?
    private var playoutFormatMixerNode: AVAudioMixerNode?
    private var pitchNode: AVAudioUnitTimePitch?
    private var gainMixerNode: AVAudioMixerNode?
    private var recorderConverter: ShannonVoiceAudioConverter?
    private var shouldPlay = false
    private var shouldRecord = false
    private var interrupted = false
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?

    init(profile: ShannonRemoteVoicePitchProfile) {
        self.profile = profile
        super.init()
    }

    private var delegate: RTCAudioDeviceDelegate? {
        get { lock.withLock { delegateStorage } }
        set { lock.withLock { delegateStorage = newValue } }
    }

    var deviceInputSampleRate: Double { inputFormat?.sampleRate ?? session.sampleRate }
    var inputIOBufferDuration: TimeInterval { session.ioBufferDuration }
    var inputNumberOfChannels: Int {
        Int(inputFormat?.channelCount ?? AVAudioChannelCount(max(1, min(2, session.inputNumberOfChannels))))
    }
    var inputLatency: TimeInterval { session.inputLatency }

    var deviceOutputSampleRate: Double { outputFormat?.sampleRate ?? session.sampleRate }
    var outputIOBufferDuration: TimeInterval { session.ioBufferDuration }
    var outputNumberOfChannels: Int {
        Int(outputFormat?.channelCount ?? AVAudioChannelCount(max(1, min(2, session.outputNumberOfChannels))))
    }
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
        interrupted = false
        shutdownEngine()
        delegate = nil
        return true
    }

    func initializePlayout() -> Bool { isPlayoutInitialized }
    func initializeRecording() -> Bool { isRecordingInitialized }

    func startPlayout() -> Bool {
        shouldPlay = true
        let succeeded = updateEngine()
        if !succeeded { shouldPlay = false }
        return succeeded
    }

    func stopPlayout() -> Bool {
        shouldPlay = false
        return updateEngine()
    }

    func startRecording() -> Bool {
        shouldRecord = true
        let succeeded = updateEngine()
        if !succeeded { shouldRecord = false }
        return succeeded
    }

    func stopRecording() -> Bool {
        shouldRecord = false
        return updateEngine()
    }

    func handleInterruption(_ event: ShannonRealtimeVoiceInterruptionEvent) {
        switch event {
        case .began:
            interrupted = true
            dispatchToAudioThread { device, delegate in
                delegate.notifyAudioInputInterrupted()
                delegate.notifyAudioOutputInterrupted()
                device.shutdownEngine()
            }
        case .ended(let shouldResume):
            interrupted = !shouldResume
            guard shouldResume else { return }
            dispatchToAudioThread { device, _ in
                _ = device.updateEngine()
            }
        }
    }

    func handleRouteChange() {
        dispatchToAudioThread { device, delegate in
            delegate.notifyAudioInputInterrupted()
            delegate.notifyAudioOutputInterrupted()
            device.shutdownEngine()
            _ = device.updateEngine()
        }
    }

    func handleMediaServicesReset() {
        dispatchToAudioThread { device, delegate in
            delegate.notifyAudioInputInterrupted()
            delegate.notifyAudioOutputInterrupted()
            device.shutdownEngine()
            _ = device.updateEngine()
        }
    }

    private func dispatchToAudioThread(
        _ operation: @escaping @Sendable (ShannonPitchShiftRTCAudioDevice, RTCAudioDeviceDelegate) -> Void
    ) {
        guard let delegate else { return }
        delegate.dispatchAsync { [weak self, weak delegate] in
            guard let self, let delegate else { return }
            operation(self, delegate)
        }
    }

    private func updateEngine() -> Bool {
        guard let delegate, shouldPlay || shouldRecord, !interrupted else {
            shutdownEngine()
            return true
        }

        let nextEngine: AVAudioEngine
        if let engine {
            nextEngine = engine
        } else {
            let createdEngine = AVAudioEngine()
            createdEngine.isAutoShutdownEnabled = true
            do {
                if !createdEngine.outputNode.isVoiceProcessingEnabled {
                    try createdEngine.outputNode.setVoiceProcessingEnabled(true)
                }
            } catch {
                shutdownEngine(createdEngine)
                recordFailure(stage: "voice_processing", error: error)
                return false
            }

            nextEngine = createdEngine
            engine = createdEngine
            installConfigurationObserver(for: createdEngine)
        }

        let ioAudioUnit = nextEngine.outputNode.auAudioUnit
        let shouldBypassVoiceProcessing = shouldRecord && !shouldPlay
        if nextEngine.inputNode.isVoiceProcessingBypassed != shouldBypassVoiceProcessing {
            nextEngine.inputNode.isVoiceProcessingBypassed = shouldBypassVoiceProcessing
        }
        if ioAudioUnit.isInputEnabled != shouldRecord || ioAudioUnit.isOutputEnabled != shouldPlay {
            if nextEngine.isRunning {
                nextEngine.stop()
            }
            ioAudioUnit.isInputEnabled = shouldRecord
            ioAudioUnit.isOutputEnabled = shouldPlay
        }

        if shouldRecord, sinkNode == nil, !configureRecording(engine: nextEngine, delegate: delegate) {
            shutdownEngine()
            recordFailure(stage: "recording_graph")
            return false
        }
        if !shouldRecord {
            removeRecordingGraph(from: nextEngine)
        }
        if shouldPlay, sourceNode == nil, !configurePlayout(engine: nextEngine, delegate: delegate) {
            shutdownEngine()
            recordFailure(stage: "playout_graph")
            return false
        }
        if !shouldPlay {
            removePlayoutGraph(from: nextEngine)
        }

        if !nextEngine.isRunning {
            nextEngine.prepare()
            do {
                try nextEngine.start()
                recordPitchActivationIfNeeded(in: nextEngine)
            } catch {
                shutdownEngine()
                recordFailure(stage: "engine_start", error: error)
                return false
            }
        }
        return true
    }

    private func configureRecording(
        engine: AVAudioEngine,
        delegate: RTCAudioDeviceDelegate
    ) -> Bool {
        let inputNode = engine.inputNode
        let voiceProcessingBus: AVAudioNodeBus = 1
        let nativeFormat = inputNode.outputFormat(forBus: voiceProcessingBus)
        guard nativeFormat.sampleRate > 0, nativeFormat.channelCount > 0,
              let rtcFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: nativeFormat.sampleRate,
                channels: nativeFormat.channelCount,
                interleaved: true
              ),
              let converter = ShannonVoiceAudioConverter(from: nativeFormat, to: rtcFormat) else {
            return false
        }

        let deliver = delegate.deliverRecordedData
        let render: RTCAudioDeviceRenderRecordedDataBlock = {
            _, _, _, frameCount, outputData, context in
            guard let context else { return kAudio_ParamError }
            let values = context.assumingMemoryBound(
                to: (Unmanaged<ShannonVoiceAudioConverter>, UnsafePointer<AudioBufferList>).self
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
        let recordingMixer = AVAudioMixerNode()

        engine.attach(recordingMixer)
        engine.attach(sink)
        // AVAudioEngine exposes Voice Processing I/O's capture format on bus 1,
        // while its graph connection is made from the input node's sole output.
        // Connecting from bus 1 directly produces an active-looking session with
        // silent PCM on physical iPhones.
        engine.connect(inputNode, to: recordingMixer, format: nativeFormat)
        engine.connect(recordingMixer, to: sink, format: nativeFormat)
        updateInputFormat(rtcFormat, delegate: delegate)
        recorderConverter = converter
        recordingMixerNode = recordingMixer
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
        let formatMixer = AVAudioMixerNode()
        let timePitch = AVAudioUnitTimePitch()
        let gainMixer = AVAudioMixerNode()
        timePitch.pitch = profile.pitchCents
        timePitch.rate = 1
        gainMixer.outputVolume = pow(10, profile.outputGainDecibels / 20)

        engine.attach(source)
        engine.attach(formatMixer)
        engine.attach(timePitch)
        engine.attach(gainMixer)
        engine.connect(source, to: formatMixer, format: rtcFormat)
        engine.connect(formatMixer, to: timePitch, format: nativeFormat)
        engine.connect(timePitch, to: gainMixer, format: nativeFormat)
        engine.connect(gainMixer, to: engine.mainMixerNode, format: nativeFormat)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nativeFormat)

        updateOutputFormat(rtcFormat, delegate: delegate)
        sourceNode = source
        playoutFormatMixerNode = formatMixer
        pitchNode = timePitch
        gainMixerNode = gainMixer
        return true
    }

    private func updateInputFormat(_ value: AVAudioFormat, delegate: RTCAudioDeviceDelegate) {
        let changed = inputFormat?.sampleRate != value.sampleRate
            || inputFormat?.channelCount != value.channelCount
        inputFormat = value
        if changed { delegate.notifyAudioInputParametersChange() }
    }

    private func updateOutputFormat(_ value: AVAudioFormat, delegate: RTCAudioDeviceDelegate) {
        let changed = outputFormat?.sampleRate != value.sampleRate
            || outputFormat?.channelCount != value.channelCount
        outputFormat = value
        if changed { delegate.notifyAudioOutputParametersChange() }
    }

    private func removeRecordingGraph(from engine: AVAudioEngine) {
        if let sinkNode {
            engine.disconnectNodeInput(sinkNode)
            engine.detach(sinkNode)
        }
        if let recordingMixerNode {
            engine.disconnectNodeInput(recordingMixerNode)
            engine.disconnectNodeOutput(recordingMixerNode)
            engine.detach(recordingMixerNode)
        }
        sinkNode = nil
        recordingMixerNode = nil
        recorderConverter = nil
    }

    private func removePlayoutGraph(from engine: AVAudioEngine) {
        for node in [sourceNode, playoutFormatMixerNode, pitchNode, gainMixerNode].compactMap({ $0 }) {
            engine.disconnectNodeInput(node)
            engine.disconnectNodeOutput(node)
            engine.detach(node)
        }
        sourceNode = nil
        playoutFormatMixerNode = nil
        pitchNode = nil
        gainMixerNode = nil
    }

    private func shutdownEngine(_ specificEngine: AVAudioEngine? = nil) {
        let target = specificEngine ?? engine
        if specificEngine == nil, let engineConfigurationObserver {
            NotificationCenter.default.removeObserver(engineConfigurationObserver)
            self.engineConfigurationObserver = nil
        }
        target?.stop()
        target?.reset()
        if specificEngine == nil {
            engine = nil
            sourceNode = nil
            sinkNode = nil
            recordingMixerNode = nil
            playoutFormatMixerNode = nil
            pitchNode = nil
            gainMixerNode = nil
            recorderConverter = nil
        }
    }

    private func installConfigurationObserver(for engine: AVAudioEngine) {
        let engineIdentifier = ObjectIdentifier(engine)
        engineConfigurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.dispatchToAudioThread { device, delegate in
                guard let activeEngine = device.engine,
                      ObjectIdentifier(activeEngine) == engineIdentifier,
                      (!activeEngine.isRunning || device.hasAudioFormatChanged(in: activeEngine)) else { return }
                delegate.notifyAudioInputInterrupted()
                delegate.notifyAudioOutputInterrupted()
                device.shutdownEngine()
                _ = device.updateEngine()
            }
        }
    }

    private func hasAudioFormatChanged(in engine: AVAudioEngine) -> Bool {
        if shouldRecord {
            let format = engine.inputNode.outputFormat(forBus: 1)
            if inputFormat?.sampleRate != format.sampleRate || inputFormat?.channelCount != format.channelCount {
                return true
            }
        }
        if shouldPlay {
            let format = engine.outputNode.outputFormat(forBus: 0)
            if outputFormat?.sampleRate != format.sampleRate || outputFormat?.channelCount != format.channelCount {
                return true
            }
        }
        return false
    }

    private func recordFailure(stage: String, error: Error? = nil) {
        var metadata = ["stage": stage]
        if let error {
            metadata["error"] = String(describing: error)
        }
        Task.detached(priority: .utility) {
            ShannonVoiceDiagnostics.shared.record(
                "realtime.audio.custom_device_failed",
                metadata: metadata
            )
        }
    }

    private func recordPitchActivationIfNeeded(in engine: AVAudioEngine) {
        guard shouldPlay else { return }
        let latency = engine.attachedNodes.compactMap { $0 as? AVAudioUnitTimePitch }.first?.latency ?? 0
        let metadata = [
            "stream": "remote_playout",
            "pitch_cents": String(Int(profile.pitchCents)),
            "gain_db": String(format: "%.1f", profile.outputGainDecibels),
            "audio_unit_latency_ms": String(Int((latency * 1_000).rounded())),
        ]
        Task.detached(priority: .utility) {
            ShannonVoiceDiagnostics.shared.record(
                "realtime.audio.remote_pitch_active",
                metadata: metadata
            )
        }
    }
}

private final class ShannonVoiceAudioConverter: @unchecked Sendable {
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
