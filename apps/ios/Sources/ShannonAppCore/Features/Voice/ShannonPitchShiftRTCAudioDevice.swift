#if os(iOS) && canImport(WebRTC)
import Foundation
@preconcurrency import AVFoundation
@preconcurrency import WebRTC

/// A WebRTC audio device which changes only remote playout. Microphone PCM is
/// returned to WebRTC without pitch or gain processing, through Voice Processing
/// I/O so acoustic echo cancellation remains available.
final class ShannonPitchShiftRTCAudioDevice: NSObject, RTCAudioDevice, @unchecked Sendable {
    private let profile: ShannonRemoteVoicePitchProfile
    private let session = AVAudioSession.sharedInstance()
    private let lock = NSLock()

    private var delegateStorage: RTCAudioDeviceDelegate?
    private var engine: AVAudioEngine?
    private var sourceNode: AVAudioSourceNode?
    private var sinkNode: AVAudioSinkNode?
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
        dispatchToAudioThread { device, _ in
            device.shutdownEngine()
            _ = device.updateEngine()
        }
    }

    func handleMediaServicesReset() {
        dispatchToAudioThread { device, delegate in
            delegate.notifyAudioInputInterrupted()
            delegate.notifyAudioOutputInterrupted()
            device.shutdownEngine()
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

        shutdownEngine()
        let nextEngine = AVAudioEngine()
        nextEngine.isAutoShutdownEnabled = false
        do {
            if !nextEngine.outputNode.isVoiceProcessingEnabled {
                try nextEngine.outputNode.setVoiceProcessingEnabled(true)
            }
        } catch {
            return false
        }

        if shouldRecord, !configureRecording(engine: nextEngine, delegate: delegate) {
            shutdownEngine(nextEngine)
            return false
        }
        if shouldPlay, !configurePlayout(engine: nextEngine, delegate: delegate) {
            shutdownEngine(nextEngine)
            return false
        }

        nextEngine.prepare()
        do {
            try nextEngine.start()
            engine = nextEngine
            recordPitchActivationIfNeeded(in: nextEngine)
            return true
        } catch {
            shutdownEngine(nextEngine)
            return false
        }
    }

    private func configureRecording(
        engine: AVAudioEngine,
        delegate: RTCAudioDeviceDelegate
    ) -> Bool {
        let inputNode = engine.inputNode
        let voiceProcessingBus: AVAudioNodeBus = inputNode.numberOfOutputs > 1 ? 1 : 0
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

        engine.attach(sink)
        engine.connect(inputNode, to: sink, format: nativeFormat)
        updateInputFormat(rtcFormat, delegate: delegate)
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

    private func recordPitchActivationIfNeeded(in engine: AVAudioEngine) {
        guard shouldPlay else { return }
        let timePitchLatency = engine.attachedNodes
            .compactMap { $0 as? AVAudioUnitTimePitch }
            .first?.latency ?? 0
        let latencyMilliseconds = Int((timePitchLatency * 1_000).rounded())
        let metadata = [
            "stream": "remote_playout",
            "pitch_cents": String(Int(profile.pitchCents)),
            "gain_db": String(format: "%.1f", profile.outputGainDecibels),
            "audio_unit_latency_ms": String(latencyMilliseconds),
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
