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

    private let session: ShannonGeminiLiveSessionDTO
    private let eventHandler: EventHandler
    private let captureHandler: CaptureHandler
    private let audioEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let vad = ShannonGeminiLiveVADState()
    private let captureChunker = ShannonGeminiLiveAudioChunker()
    private let outputRenderProbe = ShannonGeminiLiveOutputRenderProbe()
    private var urlSession: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var outgoing: AsyncStream<ShannonGeminiLiveOutgoingPayload>.Continuation?
    private var sendTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var keepAliveSourceNode: AVAudioSourceNode?
    private var recordingMixerNode: AVAudioMixerNode?
    private var mutedCaptureMixerNode: AVAudioMixerNode?
    private var audioStarted = false
    private var stopped = false
    private var didRecordFirstAudioSend = false
    private(set) var sentAudioSeconds: Double = 0
    private(set) var receivedAudioSeconds: Double = 0

    init(
        session: ShannonGeminiLiveSessionDTO,
        eventHandler: @escaping EventHandler,
        captureHandler: @escaping CaptureHandler
    ) {
        self.session = session
        self.eventHandler = eventHandler
        self.captureHandler = captureHandler
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
                        if case let .audio(audio) = event { self.play(audio) }
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

    func sendToolResponse(id: String, result: String) throws {
        send(try ShannonGeminiLiveProtocol.toolResponseMessage(id: id, result: result))
    }

    func finishAudioStream() throws {
        send(try ShannonGeminiLiveProtocol.audioStreamEndMessage())
    }

    func discardPlayback() {
        playerNode.stop()
        playerNode.reset()
        if audioEngine.isRunning { playerNode.play() }
    }

    func stop() {
        guard !stopped else { return }
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
        if let recordingMixerNode {
            recordingMixerNode.removeTap(onBus: 0)
            audioEngine.disconnectNodeInput(recordingMixerNode)
            audioEngine.disconnectNodeOutput(recordingMixerNode)
            audioEngine.detach(recordingMixerNode)
        }
        if let mutedCaptureMixerNode {
            audioEngine.disconnectNodeInput(mutedCaptureMixerNode)
            audioEngine.disconnectNodeOutput(mutedCaptureMixerNode)
            audioEngine.detach(mutedCaptureMixerNode)
        }
        if let keepAliveSourceNode {
            audioEngine.disconnectNodeOutput(keepAliveSourceNode)
            audioEngine.detach(keepAliveSourceNode)
        }
        keepAliveSourceNode = nil
        mutedCaptureMixerNode = nil
        recordingMixerNode = nil
        captureChunker.reset()
        audioStarted = false
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
            captureHandler: captureHandler,
            sampleRate: inputFormat.sampleRate,
            channelStride: inputFormat.isInterleaved ? Int(inputFormat.channelCount) : 1
        )
        let recordingMixer = AVAudioMixerNode()
        let mutedCaptureMixer = AVAudioMixerNode()
        let keepAliveSource = Self.makeKeepAliveSource(
            format: deviceOutputFormat,
            outputRenderProbe: outputRenderProbe
        )
        // A zero-volume mixer branch can be pruned by Voice Processing I/O on a
        // physical iPhone. -120 dB remains below the output noise floor while
        // keeping the microphone branch part of every render cycle.
        mutedCaptureMixer.outputVolume = 0.000_001

        audioEngine.attach(playerNode)
        audioEngine.attach(keepAliveSource)
        audioEngine.attach(recordingMixer)
        audioEngine.attach(mutedCaptureMixer)
        audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: outputFormat)
        // PlayerNode has no buffers until Gemini speaks. A continuously rendered
        // silent source keeps Voice Processing I/O advancing while the user talks.
        audioEngine.connect(keepAliveSource, to: audioEngine.mainMixerNode, format: deviceOutputFormat)
        audioEngine.connect(input, to: recordingMixer, format: inputFormat)
        // A terminal AVAudioSinkNode branch is not pulled by Voice Processing I/O
        // on every physical-device route. Keep capture inside the rendered output
        // graph so the microphone is guaranteed to advance, tap before attenuation,
        // and keep the downstream signal below the hardware output noise floor.
        audioEngine.connect(recordingMixer, to: mutedCaptureMixer, format: inputFormat)
        audioEngine.connect(mutedCaptureMixer, to: audioEngine.mainMixerNode, format: inputFormat)
        audioEngine.connect(
            audioEngine.mainMixerNode,
            to: audioEngine.outputNode,
            format: deviceOutputFormat
        )
        recordingMixer.installTap(
            onBus: 0,
            bufferSize: 1_024,
            format: inputFormat,
            block: captureTap
        )
        keepAliveSourceNode = keepAliveSource
        recordingMixerNode = recordingMixer
        mutedCaptureMixerNode = mutedCaptureMixer
        ShannonVoiceDiagnostics.shared.record(
            "gemini.audio.graph.connected",
            metadata: [
                "sample_rate": String(Int(inputFormat.sampleRate)),
                "channels": String(inputFormat.channelCount),
                "interleaved": String(inputFormat.isInterleaved),
                "capture": "driven_mixer_tap",
                "capture_gain_db": "-120",
                "output_sample_rate": String(Int(deviceOutputFormat.sampleRate)),
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
        captureHandler: @escaping CaptureHandler,
        sampleRate: Double,
        channelStride: Int
    ) -> AVAudioNodeTapBlock {
        { buffer, _ in
            guard let data = buffer.floatChannelData?[0] else { return }
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

    private func play(_ pcm: Data) {
        guard pcm.count >= 2 else { return }
        let frameCount = pcm.count / MemoryLayout<Int16>.size
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 24_000,
            channels: 1,
            interleaved: false
        ), let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ), let destination = buffer.int16ChannelData?[0] else { return }
        pcm.withUnsafeBytes { raw in
            guard let source = raw.baseAddress else { return }
            memcpy(destination, source, frameCount * MemoryLayout<Int16>.size)
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        receivedAudioSeconds += Double(frameCount) / 24_000
        playerNode.scheduleBuffer(buffer)
        if !playerNode.isPlaying { playerNode.play() }
    }

}

private final class ShannonGeminiLiveOutputRenderProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var didRecordStart = false

    func markStarted() {
        lock.lock()
        let shouldRecord = !didRecordStart
        didRecordStart = true
        lock.unlock()
        guard shouldRecord else { return }
        Task.detached(priority: .utility) {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.output.render.started")
        }
    }
}

private final class ShannonGeminiLiveVADState: @unchecked Sendable {
    struct Transition: Sendable {
        var speechStarted = false
        var speechEnded = false
    }

    private let lock = NSLock()
    private var consecutiveVoiceFrames = 0
    private var speaking = false
    private var lastVoiceAt: TimeInterval = 0
    private var endedForCurrentSpeech = false

    func consume(rms: Float, now: TimeInterval) -> Transition {
        lock.lock()
        defer { lock.unlock() }
        var transition = Transition()
        if rms >= 0.018 {
            consecutiveVoiceFrames += 1
            lastVoiceAt = now
            if !speaking, consecutiveVoiceFrames >= 3 {
                speaking = true
                endedForCurrentSpeech = false
                transition.speechStarted = true
            }
        } else {
            consecutiveVoiceFrames = 0
            if speaking, !endedForCurrentSpeech, now - lastVoiceAt >= 0.60 {
                endedForCurrentSpeech = true
                speaking = false
                transition.speechEnded = true
            }
        }
        return transition
    }
}
#endif
