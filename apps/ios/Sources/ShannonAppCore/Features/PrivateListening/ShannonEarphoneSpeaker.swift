import Foundation
@preconcurrency import AVFoundation

/// Says one line in Shannon's voice through the device's current output, and stops the moment that
/// output is no longer only the owner's.
///
/// The voice is the one of a voice conversation: the server's speech stream for the selected provider,
/// played with the same pitch lift. Before the first sound, and at every change of the route, the caller
/// is asked whether the sound is still private; a no stops the player at once. A hardware change that
/// stops the engine is never followed by a restart: the line ends there.
@MainActor
public final class ShannonEarphoneSpeaker: ShannonReachOutSpeaking {
    public typealias StreamSpeech = @MainActor (_ text: String, _ style: String, _ provider: ShannonSpeechProvider) async throws -> ShannonGeminiSpeechStream

    private let streamSpeech: StreamSpeech
    private let monitor: any ShannonAudioRouteMonitoring
    private let defaults: UserDefaults
    /// iPhone: prepares the audio session for speech and puts it back afterwards. The Mac needs neither.
    public var beginSession: @MainActor () throws -> Void = {}
    public var endSession: @MainActor () -> Void = {}

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var pendingBuffers = 0
    private var playedAnything = false
    private var wasCut = false
    public private(set) var isSpeaking = false
    private var fetchTask: Task<ShannonGeminiSpeechStream, Error>?
    private var feedTask: Task<Void, Error>?

    /// Her voice has to begin within this long of the request, or the line is not said.
    static let firstSoundTimeout: TimeInterval = 30
    /// The limit of this speaker; a line that answers a touch waits far less than a message of hers.
    public var firstSoundTimeout: TimeInterval = ShannonEarphoneSpeaker.firstSoundTimeout
    /// A line is over this long after the request, whatever state it is in; her longest line is well under a minute.
    static let maximumLineTime: TimeInterval = 120

    public init(streamSpeech: @escaping StreamSpeech, monitor: any ShannonAudioRouteMonitoring, defaults: UserDefaults = .standard) {
        self.streamSpeech = streamSpeech
        self.monitor = monitor
        self.defaults = defaults
    }

    public func speak(_ text: String, stillPrivate: @escaping @MainActor () -> Bool) async -> ShannonReachOutSpeechOutcome {
        let spoken = ShannonGeminiCascadeSpeech.spokenText(for: text)
        guard !spoken.isEmpty else { return .failed }
        guard !isSpeaking, engine == nil, stillPrivate() else { return .notStarted }
        isSpeaking = true
        defer { isSpeaking = false }
        let provider = ShannonSpeechProvider.current(defaults: defaults)
        let style = provider == .gemini
            ? ShannonGeminiCascadeSpeech.style(for: text, plan: nil)
            : ShannonElevenCascadeSpeech.style(for: text, plan: nil)
        pendingBuffers = 0
        playedAnything = false
        wasCut = false
        // Two limits hold for the whole line, from the request to the last sample: her voice has to begin within the
        // first, and the line is over by the second. Either one stops the line where it is.
        let patience = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(self?.firstSoundTimeout ?? Self.firstSoundTimeout)) } catch { return }
            guard !Task.isCancelled else { return }
            if self?.playedAnything == false { self?.cut() }
        }
        let limit = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(Self.maximumLineTime)) } catch { return }
            guard !Task.isCancelled else { return }
            self?.cut()
        }
        let stream: ShannonGeminiSpeechStream
        let fetch = Task { @MainActor [streamSpeech] in try await streamSpeech(spoken, style, provider) }
        fetchTask = fetch
        defer {
            patience.cancel()
            limit.cancel()
            fetchTask = nil
        }
        do {
            stream = try await fetch.value
        } catch {
            return .failed
        }
        guard stream.sampleRate == 24_000, stream.channels == 1, stream.bitsPerSample == 16 else { return .failed }
        // The request took a moment; the earphones may have gone meanwhile, or the line was stopped.
        guard !wasCut, stillPrivate() else { return .notStarted }
        do {
            try beginSession()
            // Preparing the session can itself move the sound to another output.
            guard stillPrivate() else {
                teardown()
                return .notStarted
            }
            try start()
        } catch {
            teardown()
            return .failed
        }
        // Any change of where the sound comes out is checked at once; the engine stopping by itself ends the line.
        let changes = monitor.changes()
        let watcher = Task { @MainActor [weak self] in
            for await _ in changes {
                if !stillPrivate() { self?.cut() }
            }
        }
        let engineObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.cut() }
        }
        defer {
            watcher.cancel()
            NotificationCenter.default.removeObserver(engineObserver)
            teardown()
        }

        var failed = false
        // Fed by a task of its own, so that cutting the line also stops waiting for sound that has not arrived.
        let feeding = Task { @MainActor [weak self] in
            for try await chunk in stream.chunks {
                guard let self, !self.wasCut else { return }
                // Asked again for every piece of sound: nothing is queued for an output that stopped being private.
                guard stillPrivate() else { self.cut(); return }
                try self.schedule(chunk)
            }
        }
        feedTask = feeding
        do {
            try await feeding.value
        } catch {
            failed = !wasCut
        }
        feedTask = nil
        // Wait until everything queued was really played, or the line was cut (the limits above cut it too).
        var polls = 0
        while pendingBuffers > 0, !wasCut {
            polls += 1
            // The route is also read on a timer, in case a change was not announced.
            if engine?.isRunning != true || (polls % 5 == 0 && !stillPrivate()) { cut(); break }
            try? await Task.sleep(for: .milliseconds(40))
        }
        if wasCut { return playedAnything ? .cutShort : .notStarted }
        if failed { return playedAnything ? .cutShort : .failed }
        return playedAnything ? .spoken : .failed
    }

    public func stop() {
        cut()
    }

    private func cut() {
        fetchTask?.cancel()
        guard !wasCut else { return }
        wasCut = true
        feedTask?.cancel()
        player?.stop()
        engine?.stop()
    }

    private func start() throws {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let pitch = AVAudioUnitTimePitch()
        let profile = ShannonGeminiVoiceEffectPolicy.profile(defaults: defaults)
        pitch.pitch = profile.pitchCents
        pitch.rate = 1
        pitch.bypass = profile.pitchCents == 0
        guard let format = Self.playbackFormat else { throw URLError(.cannotDecodeRawData) }
        engine.attach(player)
        engine.attach(pitch)
        engine.connect(player, to: pitch, format: format)
        ShannonSpeechLevelPublisher.shared.observe(player) // her mouth, for whoever draws her
        engine.connect(pitch, to: engine.mainMixerNode, format: format)
        engine.prepare()
        try engine.start()
        player.play()
        self.engine = engine
        self.player = player
    }

    private func teardown() {
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
        pendingBuffers = 0
        endSession()
    }

    static let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)

    /// 16-bit mono PCM at 24 kHz, as the speech stream sends it, queued as float samples.
    private func schedule(_ pcm: Data) throws {
        guard let player, let engine, engine.isRunning, let format = Self.playbackFormat,
              let buffer = Self.buffer(from: pcm, format: format) else { throw URLError(.cannotDecodeRawData) }
        pendingBuffers += 1
        // Sound queued on a running player counts as heard from here on: a line cut a moment later is reported as
        // cut short, never as unsaid, so that no other surface says the whole of it again.
        playedAnything = true
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.pendingBuffers > 0 else { return }
                self.pendingBuffers -= 1
            }
        }
    }

    static func buffer(from pcm: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frames = pcm.count / MemoryLayout<Int16>.size
        guard frames > 0, pcm.count % MemoryLayout<Int16>.size == 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let samples = buffer.floatChannelData?[0] else { return nil }
        pcm.withUnsafeBytes { raw in
            for index in 0..<frames {
                let sample = raw.loadUnaligned(fromByteOffset: index * MemoryLayout<Int16>.size, as: Int16.self)
                samples[index] = Float(Int16(littleEndian: sample)) / 32_768
            }
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        return buffer
    }
}
