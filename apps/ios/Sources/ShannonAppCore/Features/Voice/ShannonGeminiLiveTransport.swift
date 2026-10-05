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
    typealias EventHandler = @MainActor @Sendable (ShannonTranscriptionEvent) -> Void
    typealias CaptureHandler = @MainActor @Sendable (
        _ rms: Float,
        _ capturedSeconds: Double,
        _ speechStarted: Bool,
        _ speechEnded: Bool,
        _ emittedAudioChunks: Int
    ) -> Void
    typealias InputStateHandler = @MainActor @Sendable (ShannonVoiceInputState) -> Void
    typealias AudioStateHandler = @MainActor @Sendable (ShannonGeminiLiveAudioState) -> Void
    private let session: ShannonGeminiLiveSessionDTO
    let eventHandler: EventHandler
    private let captureHandler: CaptureHandler
    let inputStateHandler: InputStateHandler
    let audioStateHandler: AudioStateHandler
    let audioEngine = AVAudioEngine()
    let playerNode = AVAudioPlayerNode()
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
    var audioStarted = false
    var stopped = false
    /// The system took the audio session away (a phone call, Siri, another app); nothing is captured or played.
    var interrupted = false
    private var didRecordFirstAudioSend = false
    var inputPreference: ShannonVoiceInputPreference = .automatic
    var preferenceUnavailable = false
    private var inputMuted = false
    var audioObservers: [NSObjectProtocol] = []
#if os(macOS)
    /// The Mac microphone the owner chose (Core Audio's unique id); nil is the system's input.
    var inputDeviceID: String?
    /// Stops listening for microphones that come and go.
    var stopObservingDevices: (() -> Void)?
    /// The microphone set on the input unit before voice processing; nil for the system's input.
    var appliedInputDevice: AudioDeviceID?
    var appliedInputUID: String?
    /// The microphone behind voice processing's aggregate, as Core Audio reports it once the audio runs.
    var heardInputName: String?
#endif
    private(set) var sentAudioSeconds: Double = 0
    private(set) var receivedAudioSeconds: Double = 0
    init(
        session: ShannonGeminiLiveSessionDTO,
        eventHandler: @escaping EventHandler,
        captureHandler: @escaping CaptureHandler,
        inputStateHandler: @escaping InputStateHandler,
        audioStateHandler: @escaping AudioStateHandler = { _ in }
    ) {
        self.session = session
        self.eventHandler = eventHandler
        self.captureHandler = captureHandler
        self.inputStateHandler = inputStateHandler
        self.audioStateHandler = audioStateHandler
    }
    func start() async throws {
        stopped = false
        sentAudioSeconds = 0
        didRecordFirstAudioSend = false
        try configureAudioSession()
        let request = try ShannonOpenAITranscriptionProtocol.webSocketRequest(token: session.token)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        let nextURLSession = URLSession(configuration: configuration)
        let nextSocket = nextURLSession.webSocketTask(with: request)
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
                    try await nextSocket.send(.string(String(decoding: payload.data, as: UTF8.self)))
                    if payload.kind == .audio {
                        self?.sentAudioSeconds += Double(payload.audioByteCount) / 48_000
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
                    for event in try ShannonOpenAITranscriptionProtocol.events(from: data) {
                        if case .sessionReady = event, !self.audioStarted {
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
    }
    func discardPlayback() {
        playbackDrain.cancel()
        playerNode.stop()
        playerNode.reset()
        playbackFormatMixerNode.reset()
        pitchNode.reset()
        if audioEngine.isRunning { playerNode.play() }
    }
    /// Voice Processing delivers silence while muted, so nothing the user says is sent.
    func setInputMuted(_ muted: Bool) {
        inputMuted = muted
        if inputTapInstalled { audioEngine.inputNode.isVoiceProcessingInputMuted = muted }
    }
    func setPlaybackVolume(_ volume: Float) {
        playerNode.volume = min(1, max(0, volume))
    }
    func setInputPreference(_ preference: ShannonVoiceInputPreference) throws {
        inputPreference = preference
        guard !audioObservers.isEmpty else { return }
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

    /// `onPlayed` runs once this chunk has actually been played (never for discarded audio).
    @discardableResult
    func schedulePCM(_ pcm: Data, onPlayed: (@MainActor () -> Void)? = nil) throws -> Double {
        guard !pcm.isEmpty, pcm.count % MemoryLayout<Int16>.size == 0 else {
            throw URLError(.cannotDecodeRawData)
        }
        try play(pcm, onPlayed: onPlayed)
        return Double(pcm.count) / 48_000
    }

    /// Each played chunk, with whether more of her voice is still queued behind it.
    var playbackProgress: (@MainActor (_ stillPlaying: Bool) -> Void)? {
        get { playbackDrain.onProgress }
        set { playbackDrain.onProgress = newValue }
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
        removeAudioObservers()
        interrupted = false
        deactivateAudioSession()
    }

    private func startAudioEngine() throws {
        ShannonVoiceDiagnostics.shared.record("gemini.audio.engine.start.before")
        let input = audioEngine.inputNode
        // The Mac chooses its microphone on the I/O unit, before voice processing takes it over and again after.
        prepareInputDevice()
        if !audioEngine.outputNode.isVoiceProcessingEnabled {
            try audioEngine.outputNode.setVoiceProcessingEnabled(true)
        }
        let ioAudioUnit = audioEngine.outputNode.auAudioUnit
        ioAudioUnit.isInputEnabled = true
        ioAudioUnit.isOutputEnabled = true
        input.isVoiceProcessingBypassed = false
        input.isVoiceProcessingInputMuted = inputMuted

        confirmInputDevice()
        // Voice Processing I/O exposes the physical microphone format on bus 1,
        // even though the input node must be connected from its sole graph output.
        // Reading bus 0 here can produce an active engine with silent capture on iPhone.
        let inputFormat = Self.captureFormat(of: input)
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
        ShannonSpeechLevelPublisher.shared.observe(playerNode) // her mouth, for whoever draws her
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

    /// The microphone's own format. The iPhone's Voice Processing I/O reports it on bus 1; the Mac's input
    /// node has one output bus, and asking for a bus it does not have raises.
    private static func captureFormat(of input: AVAudioInputNode) -> AVAudioFormat {
#if os(iOS)
        input.outputFormat(forBus: 1)
#else
        input.outputFormat(forBus: 0)
#endif
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
            let pcm = ShannonGeminiLivePCM.pcm16Mono(
                samples: samples,
                sampleRate: sampleRate,
                stride: channelStride
            )
            let chunks = captureChunker.append(pcm)
            for chunk in chunks {
                if let payload = try? ShannonOpenAITranscriptionProtocol.audioMessage(chunk) {
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

    private func play(_ pcm: Data, onPlayed: (@MainActor () -> Void)? = nil) throws {
        guard pcm.count >= 2 else { throw URLError(.cannotDecodeRawData) }
        // Starting a player on a stopped engine raises an Objective-C exception; an interrupted call plays nothing.
        guard isAudioRunning else { throw URLError(.networkConnectionLost) }
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
        let ticket = playbackDrain.schedule(onPlayed: onPlayed)
        playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.playbackDrain.played(ticket) }
        }
        if !playerNode.isPlaying { playerNode.play() }
    }

}
