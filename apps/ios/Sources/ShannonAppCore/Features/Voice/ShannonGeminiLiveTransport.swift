#if os(iOS)
import Foundation
@preconcurrency import AVFoundation
private struct ShannonGeminiLiveOutgoingPayload: Sendable {
    enum Kind: Sendable, Equatable {
        case control
        case audio
    }
    let data: Data
    let kind: Kind
    let audioByteCount: Int
}
@MainActor
final class ShannonGeminiLiveTransport {
    typealias EventHandler = @MainActor @Sendable (ShannonGeminiLiveServerEvent) -> Void
    typealias CaptureHandler = @MainActor @Sendable (
        _ rms: Float,
        _ capturedSeconds: Double,
        _ speechStarted: Bool,
        _ speechEnded: Bool,
        _ emittedAudioChunks: Int
    ) -> Void
    typealias InputStateHandler = @MainActor @Sendable (ShannonVoiceInputState) -> Void
    private let session: ShannonGeminiLiveSessionDTO
    private let eventHandler: EventHandler
    private let captureHandler: CaptureHandler
    private let inputStateHandler: InputStateHandler
    private let audioEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let playbackDrain = ShannonVoicePlaybackDrain()
    private let playbackFormatMixerNode = AVAudioMixerNode()
    private let pitchNode = AVAudioUnitTimePitch()
    private let voiceEffectProfile = ShannonGeminiVoiceEffectPolicy.profile()
    private let vad = ShannonGeminiLiveVADState()
    private let captureChunker = ShannonGeminiLiveAudioChunker()
    private let outputRenderProbe = ShannonGeminiLiveOutputRenderProbe()
    private var urlSession: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var outgoing: AsyncStream<ShannonGeminiLiveOutgoingPayload>.Continuation?
    private var sendTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var keepAliveSourceNode: AVAudioSourceNode?
    private var inputTapInstalled = false
    private var audioStarted = false
    private var stopped = false
    private var didRecordFirstAudioSend = false
    private var inputPreference: ShannonVoiceInputPreference = .automatic
    private var routeObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private(set) var sentAudioSeconds: Double = 0
    private(set) var receivedAudioSeconds: Double = 0
    init(
        session: ShannonGeminiLiveSessionDTO,
        eventHandler: @escaping EventHandler,
        captureHandler: @escaping CaptureHandler,
        inputStateHandler: @escaping InputStateHandler
    ) {
        self.session = session
        self.eventHandler = eventHandler
        self.captureHandler = captureHandler
        self.inputStateHandler = inputStateHandler
    }
    func start(resumptionHandle: String? = nil) async throws {
        stopped = false
        sentAudioSeconds = 0
        didRecordFirstAudioSend = false
        try configureAudioSession()
        let url = try ShannonGeminiLiveProtocol.webSocketURL(token: session.token)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        let nextURLSession = URLSession(configuration: configuration)
        let nextSocket = nextURLSession.webSocketTask(with: url)
        urlSession = nextURLSession
        socket = nextSocket
        var streamContinuation: AsyncStream<ShannonGeminiLiveOutgoingPayload>.Continuation?
        let stream = AsyncStream<ShannonGeminiLiveOutgoingPayload> { streamContinuation = $0 }
        guard let streamContinuation else { throw URLError(.cannotCreateFile) }
        outgoing = streamContinuation
        nextSocket.resume()
        sendTask = Task { [weak self, weak nextSocket] in
            guard let nextSocket else { return }
            do {
                for await payload in stream {
                    try Task.checkCancellation()
                    try await nextSocket.send(.data(payload.data))
                    if payload.kind == .audio {
                        self?.sentAudioSeconds += Double(payload.audioByteCount) / 32_000
                        if self?.didRecordFirstAudioSend == false {
                            self?.didRecordFirstAudioSend = true
                            ShannonVoiceDiagnostics.shared.record(
                                "gemini.audio.chunk.sent",
                                metadata: ["pcm_bytes": String(payload.audioByteCount)]
                            )
                        }
                    }
                }
            } catch {
                guard !Task.isCancelled else { return }
                self?.eventHandler(.goAway(nil))
            }
        }
        receiveTask = Task { [weak self, weak nextSocket] in
            guard let self, let nextSocket else { return }
            do {
                while !Task.isCancelled {
                    let message = try await nextSocket.receive()
                    let data: Data
                    switch message {
                    case let .data(value): data = value
                    case let .string(value): data = Data(value.utf8)
                    @unknown default: continue
                    }
                    for event in try ShannonGeminiLiveProtocol.events(from: data) {
                        if case .setupComplete = event, !self.audioStarted {
                            do {
                                try self.startAudioEngine()
                                self.audioStarted = true
                            } catch {
                                self.eventHandler(.goAway(nil))
                                return
                            }
                        }
                        self.eventHandler(event)
                    }
                }
            } catch {
                guard !Task.isCancelled, !self.stopped else { return }
                self.eventHandler(.goAway(nil))
            }
        }
        send(try ShannonGeminiLiveProtocol.setupMessage(session: session, resumptionHandle: resumptionHandle))
    }
    func finishAudioStream() throws {
        send(try ShannonGeminiLiveProtocol.audioStreamEndMessage())
    }
    func discardPlayback() {
        playbackDrain.cancel()
        playerNode.stop()
        playerNode.reset()
        playbackFormatMixerNode.reset()
        pitchNode.reset()
        if audioEngine.isRunning { playerNode.play() }
    }
    func setPlaybackVolume(_ volume: Float) {
        playerNode.volume = min(1, max(0, volume))
    }
    func setInputPreference(_ preference: ShannonVoiceInputPreference) throws {
        inputPreference = preference
        guard routeObserver != nil else { return }
        try applyInputPreference()
    }

    @discardableResult
    func scheduleSpeech(_ speech: ShannonGeminiSpeech) throws -> Double {
        let wav = try ShannonGeminiWAV.parse(speech.audio)
        guard wav.sampleRate == 24_000, wav.channels == 1, wav.bitsPerSample == 16 else {
            throw URLError(.cannotDecodeRawData)
        }
        try play(wav.pcm)
        return speech.durationSeconds
    }

    @discardableResult
    func schedulePCM(_ pcm: Data) throws -> Double {
        guard !pcm.isEmpty, pcm.count % MemoryLayout<Int16>.size == 0 else {
            throw URLError(.cannotDecodeRawData)
        }
        try play(pcm)
        return Double(pcm.count) / 48_000
    }

    func waitForPlayback() async throws {
        try await playbackDrain.wait()
    }

    func stop() {
        guard !stopped else { return }
        playbackDrain.cancel()
        stopped = true
        outgoing?.finish()
        outgoing = nil
        sendTask?.cancel()
        receiveTask?.cancel()
        sendTask = nil
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        playerNode.stop()
        audioEngine.stop()
        if inputTapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            inputTapInstalled = false
        }
        if let keepAliveSourceNode {
            audioEngine.disconnectNodeOutput(keepAliveSourceNode)
            audioEngine.detach(keepAliveSourceNode)
        }
        keepAliveSourceNode = nil
        captureChunker.reset()
        audioStarted = false
        if let routeObserver {
            NotificationCenter.default.removeObserver(routeObserver)
            self.routeObserver = nil
        }
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func configureAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try audioSession.setPreferredIOBufferDuration(0.02)
        try audioSession.setActive(true)
        try applyInputPreference()
        if interruptionObserver == nil {
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: audioSession,
                queue: .main
            ) { [weak self] notification in
                let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                Task { @MainActor [weak self] in
                    guard let self, !self.stopped,
                          let rawType,
                          let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
                    guard type == .ended else { return }
                    let mayResume = AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume)
                    guard mayResume else {
                        self.eventHandler(.goAway(nil))
                        return
                    }
                    do {
                        try AVAudioSession.sharedInstance().setActive(true)
                        if self.audioStarted && !self.audioEngine.isRunning {
                            try self.audioEngine.start()
                            self.playerNode.play()
                        }
                        try self.applyInputPreference()
                    } catch {
                        self.eventHandler(.goAway(nil))
                    }
                }
            }
        }
        if routeObserver == nil {
            routeObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: audioSession,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    try? self.applyInputPreference()
                }
            }
        }
    }

    private func applyInputPreference() throws {
        let audioSession = AVAudioSession.sharedInstance()
        let inputs = audioSession.availableInputs ?? []
        let selected: AVAudioSessionPortDescription?
        switch inputPreference {
        case .automatic:
            selected = nil
        case .builtIn:
            guard let input = inputs.first(where: { $0.portType == .builtInMic }) else {
                publishInputState()
                throw URLError(.cannotOpenFile)
            }
            selected = input
        case .connected:
            guard let input = inputs.first(where: { $0.portType != .builtInMic }) else {
                publishInputState()
                throw URLError(.cannotOpenFile)
            }
            selected = input
        }
        if audioSession.preferredInput?.uid != selected?.uid {
            try audioSession.setPreferredInput(selected)
        }
        publishInputState()
    }

    private func publishInputState() {
        let audioSession = AVAudioSession.sharedInstance()
        let inputs = audioSession.availableInputs ?? []
        inputStateHandler(ShannonVoiceInputState(
            preference: inputPreference,
            activeInputName: audioSession.currentRoute.inputs.first?.portName,
            isBuiltInAvailable: inputs.contains(where: { $0.portType == .builtInMic }),
            isConnectedInputAvailable: inputs.contains(where: { $0.portType != .builtInMic })
        ))
    }

    private func startAudioEngine() throws {
        ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.start.before")
        let input = audioEngine.inputNode
        if !audioEngine.outputNode.isVoiceProcessingEnabled {
            try audioEngine.outputNode.setVoiceProcessingEnabled(true)
        }
        let ioAudioUnit = audioEngine.outputNode.auAudioUnit
        ioAudioUnit.isInputEnabled = true
        ioAudioUnit.isOutputEnabled = true
        input.isVoiceProcessingBypassed = false

        // Voice Processing I/O exposes the physical microphone format on bus 1,
        // even though the input node must be connected from its sole graph output.
        // Reading bus 0 here can produce an active engine with silent capture on iPhone.
        let inputFormat = input.outputFormat(forBus: 1)
        guard inputFormat.sampleRate > 0,
              inputFormat.channelCount > 0,
              inputFormat.commonFormat == .pcmFormatFloat32 else {
            throw URLError(.cannotDecodeRawData)
        }
        let deviceOutputFormat = audioEngine.outputNode.outputFormat(forBus: 0)
        guard deviceOutputFormat.sampleRate > 0,
              deviceOutputFormat.channelCount > 0 else {
            throw URLError(.cannotDecodeRawData)
        }

        let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 24_000,
            channels: 1,
            interleaved: false
        )!
        let outgoing = self.outgoing
        let vad = self.vad
        let captureChunker = self.captureChunker
        let captureHandler = self.captureHandler
        let captureTap = Self.makeCaptureTap(
            outgoing: outgoing,
            vad: vad,
            captureChunker: captureChunker,
            captureHandler: captureHandler
        )
        let keepAliveSource = Self.makeKeepAliveSource(
            format: deviceOutputFormat,
            outputRenderProbe: outputRenderProbe
        )

        pitchNode.pitch = voiceEffectProfile.pitchCents
        pitchNode.rate = 1
        pitchNode.bypass = voiceEffectProfile.pitchCents == 0
        audioEngine.attach(playerNode)
        audioEngine.attach(playbackFormatMixerNode)
        audioEngine.attach(pitchNode)
        audioEngine.attach(keepAliveSource)
        audioEngine.connect(playerNode, to: playbackFormatMixerNode, format: outputFormat)
        audioEngine.connect(playbackFormatMixerNode, to: pitchNode, format: deviceOutputFormat)
        audioEngine.connect(pitchNode, to: audioEngine.mainMixerNode, format: deviceOutputFormat)
        // PlayerNode has no buffers until Gemini speaks. A continuously rendered
        // silent source keeps Voice Processing I/O advancing while the user talks.
        audioEngine.connect(keepAliveSource, to: audioEngine.mainMixerNode, format: deviceOutputFormat)
        audioEngine.connect(
            audioEngine.mainMixerNode,
            to: audioEngine.outputNode,
            format: deviceOutputFormat
        )
        // The silent output source keeps the I/O render cycle alive, so capture can
        // use the input node's native tap without connecting microphone samples to
        // the audible mixer. This prevents local sidetone while retaining Apple's
        // Voice Processing echo cancellation for full-duplex conversation.
        input.installTap(
            onBus: 0,
            bufferSize: 1_024,
            format: nil,
            block: captureTap
        )
        keepAliveSourceNode = keepAliveSource
        inputTapInstalled = true
        ShannonVoiceDiagnostics.shared.record(
            "gemini.audio.graph.connected",
            metadata: [
                "sample_rate": String(Int(inputFormat.sampleRate)),
                "channels": String(inputFormat.channelCount),
                "interleaved": String(inputFormat.isInterleaved),
                "capture": "voice_processing_input_tap",
                "monitoring": "disconnected",
                "output_sample_rate": String(Int(deviceOutputFormat.sampleRate)),
                "playout_pitch_cents": String(Int(voiceEffectProfile.pitchCents)),
                "playout_robot_amount": String(voiceEffectProfile.robotAmount),
            ]
        )
        ShannonVoiceDiagnostics.shared.record("gemini.audio.tap.installed")
        audioEngine.prepare()
        try audioEngine.start()
        ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.started")
        playerNode.play()
        ShannonVoiceDiagnostics.shared.record("gemini.audio.player.started")
    }

    /// AVAudioSourceNode is pulled on Core Audio's realtime I/O thread. Keep the
    /// callback nonisolated so Swift never inserts a MainActor precondition there.
    nonisolated private static func makeKeepAliveSource(
        format: AVAudioFormat,
        outputRenderProbe: ShannonGeminiLiveOutputRenderProbe
    ) -> AVAudioSourceNode {
        AVAudioSourceNode(format: format) { isSilence, _, _, outputData in
            outputRenderProbe.markStarted()
            isSilence.pointee = true
            for buffer in UnsafeMutableAudioBufferListPointer(outputData) {
                guard let data = buffer.mData else { continue }
                memset(data, 0, Int(buffer.mDataByteSize))
            }
            return noErr
        }
    }

    /// AVAudioEngine invokes this tap on Core Audio's realtime I/O thread.
    /// Constructing the closure inside the @MainActor transport method makes Swift
    /// inherit MainActor isolation and traps at runtime before the first PCM frame.
    /// Keep the callback factory explicitly nonisolated and hop only the UI update.
    nonisolated private static func makeCaptureTap(
        outgoing: AsyncStream<ShannonGeminiLiveOutgoingPayload>.Continuation?,
        vad: ShannonGeminiLiveVADState,
        captureChunker: ShannonGeminiLiveAudioChunker,
        captureHandler: @escaping CaptureHandler
    ) -> AVAudioNodeTapBlock {
        { buffer, _ in
            guard let data = buffer.floatChannelData?[0] else { return }
            let sampleRate = buffer.format.sampleRate
            let channelStride = buffer.format.isInterleaved
                ? Int(buffer.format.channelCount)
                : 1
            guard sampleRate > 0, channelStride > 0 else { return }
            let frameCount = Int(buffer.frameLength)
            let sampleCount = frameCount * channelStride
            let samples = UnsafeBufferPointer(start: data, count: sampleCount)
            let pcm = ShannonGeminiLivePCM.pcm16Mono16k(
                samples: samples,
                sampleRate: sampleRate,
                stride: channelStride
            )
            let chunks = captureChunker.append(pcm)
            for chunk in chunks {
                if let payload = try? ShannonGeminiLiveProtocol.audioMessage(chunk) {
                    outgoing?.yield(.init(data: payload, kind: .audio, audioByteCount: chunk.count))
                }
            }
            let emittedAudioChunks = chunks.count
            let rms = ShannonGeminiLivePCM.rootMeanSquare(samples: samples, stride: channelStride)
            let transition = vad.consume(rms: rms, now: ProcessInfo.processInfo.systemUptime)
            let capturedSeconds = Double(frameCount) / sampleRate
            Task { @MainActor in
                captureHandler(
                    rms,
                    capturedSeconds,
                    transition.speechStarted,
                    transition.speechEnded,
                    emittedAudioChunks
                )
            }
        }
    }

    private func send(_ data: Data) {
        outgoing?.yield(.init(data: data, kind: .control, audioByteCount: 0))
    }

    private func play(_ pcm: Data) throws {
        guard pcm.count >= 2 else { throw URLError(.cannotDecodeRawData) }
        let frameCount = pcm.count / MemoryLayout<Int16>.size
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 24_000,
            channels: 1,
            interleaved: false
        ), let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ), let destination = buffer.int16ChannelData?[0] else { throw URLError(.cannotDecodeRawData) }
        pcm.withUnsafeBytes { raw in
            guard let source = raw.baseAddress else { return }
            memcpy(destination, source, frameCount * MemoryLayout<Int16>.size)
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        receivedAudioSeconds += Double(frameCount) / 24_000
        let ticket = playbackDrain.schedule()
        playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.playbackDrain.played(ticket) }
        }
        if !playerNode.isPlaying { playerNode.play() }
    }

}
#endif
