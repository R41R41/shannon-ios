#if os(iOS)
import Foundation
@preconcurrency import AVFoundation

@MainActor
final class ShannonGeminiLiveTransport {
    typealias EventHandler = @MainActor @Sendable (ShannonGeminiLiveServerEvent) -> Void
    typealias CaptureHandler = @MainActor @Sendable (
        _ rms: Float,
        _ capturedSeconds: Double,
        _ speechStarted: Bool,
        _ speechEnded: Bool
    ) -> Void

    private let session: ShannonGeminiLiveSessionDTO
    private let eventHandler: EventHandler
    private let captureHandler: CaptureHandler
    private let audioEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let vad = ShannonGeminiLiveVADState()
    private var urlSession: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var outgoing: AsyncStream<Data>.Continuation?
    private var sendTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var inputTapInstalled = false
    private var audioStarted = false
    private var stopped = false
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
        try configureAudioSession()

        let url = try ShannonGeminiLiveProtocol.webSocketURL(token: session.token)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        let nextURLSession = URLSession(configuration: configuration)
        let nextSocket = nextURLSession.webSocketTask(with: url)
        urlSession = nextURLSession
        socket = nextSocket

        var streamContinuation: AsyncStream<Data>.Continuation?
        let stream = AsyncStream<Data> { streamContinuation = $0 }
        guard let streamContinuation else { throw URLError(.cannotCreateFile) }
        outgoing = streamContinuation
        nextSocket.resume()

        sendTask = Task { [weak self, weak nextSocket] in
            guard let nextSocket else { return }
            do {
                for await payload in stream {
                    try Task.checkCancellation()
                    try await nextSocket.send(.data(payload))
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
        if inputTapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            inputTapInstalled = false
        }
        audioEngine.stop()
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
        let input = audioEngine.inputNode
        if !audioEngine.outputNode.isVoiceProcessingEnabled {
            try audioEngine.outputNode.setVoiceProcessingEnabled(true)
        }
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw URLError(.cannotDecodeRawData)
        }

        let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 24_000,
            channels: 1,
            interleaved: false
        )!
        audioEngine.attach(playerNode)
        audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: outputFormat)

        let outgoing = self.outgoing
        let vad = self.vad
        let captureHandler = self.captureHandler
        input.installTap(onBus: 0, bufferSize: 1_920, format: inputFormat) { buffer, _ in
            guard let channel = buffer.floatChannelData?[0] else { return }
            let samples = UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))
            let pcm = ShannonGeminiLivePCM.pcm16Mono16k(samples: samples, sampleRate: inputFormat.sampleRate)
            guard !pcm.isEmpty else { return }
            if let payload = try? ShannonGeminiLiveProtocol.audioMessage(pcm) {
                outgoing?.yield(payload)
            }
            let rms = ShannonGeminiLivePCM.rootMeanSquare(samples: samples)
            let transition = vad.consume(rms: rms, now: ProcessInfo.processInfo.systemUptime)
            let capturedSeconds = Double(buffer.frameLength) / inputFormat.sampleRate
            Task { @MainActor in
                captureHandler(rms, capturedSeconds, transition.speechStarted, transition.speechEnded)
            }
        }
        inputTapInstalled = true
        audioEngine.prepare()
        try audioEngine.start()
        playerNode.play()
    }

    private func send(_ data: Data) {
        outgoing?.yield(data)
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
