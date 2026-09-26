#if os(iOS)
import Foundation
@preconcurrency import AVFoundation
import Observation

@MainActor
@Observable
public final class ShannonVoiceLabAudioController {
    public var selectedPreset = ShannonVoiceLabPreset.comparisonSet[0]
    public var selectedSource = ShannonVoiceLabSource.fixedJapanese
    public var customPitchCents = ShannonVoiceLabTuning.defaultPitchCents
    public var customFormantSemitones = ShannonVoiceLabTuning.defaultFormantSemitones
    public var rvcConfiguration = ShannonVoiceLabRVCConfiguration()
    public private(set) var sourceLabel = "未準備"
    public private(set) var status = "固定文を準備してください"
    public private(set) var errorMessage: String?
    public private(set) var isBusy = false
    public private(set) var isPlaying = false
    public private(set) var measurements: [ShannonVoiceLabMeasurement] = []

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private let equalizer = AVAudioUnitEQ(numberOfBands: 2)
    private let speechSynthesizer = AVSpeechSynthesizer()
    private let rvcClient = ShannonVoiceLabRVCClient()
    private var speechWriter: ShannonVoiceLabSpeechWriter?
    private var sourceBuffer: AVAudioPCMBuffer?

    public init() {
        configureEffectDefaults()
        engine.attach(player)
        engine.attach(timePitch)
        engine.attach(equalizer)
    }

    public func prepareFixedJapanese() async {
        await performBusyAction {
            let url = try await synthesizeFixedJapanese()
            sourceBuffer = try Self.readPCM(from: url)
            selectedSource = .fixedJapanese
            sourceLabel = "固定日本語・\(Self.durationLabel(sourceBuffer))"
            status = "同一PCMで比較できます"
        }
    }

    public func importWAV(from url: URL) async {
        await performBusyAction {
            let granted = url.startAccessingSecurityScopedResource()
            defer { if granted { url.stopAccessingSecurityScopedResource() } }
            sourceBuffer = try Self.readPCM(from: url)
            selectedSource = .importedWAV
            sourceLabel = "\(url.lastPathComponent)・\(Self.durationLabel(sourceBuffer))"
            status = "WAVを読み込みました"
        }
    }

    public func playSelectedPreset() async {
        await performBusyAction {
            guard selectedSource != .realtime else {
                throw ShannonVoiceLabError.realtimeRequiresLiveSession
            }
            if sourceBuffer == nil, selectedSource == .fixedJapanese {
                let url = try await synthesizeFixedJapanese()
                sourceBuffer = try Self.readPCM(from: url)
                sourceLabel = "固定日本語・\(Self.durationLabel(sourceBuffer))"
            }
            guard let sourceBuffer else { throw ShannonVoiceLabError.noSource }

            stopPlayback()
            let started = ContinuousClock.now
            let prepared = try await prepareForPlayback(sourceBuffer, preset: selectedPreset)
            let processingDuration = started.duration(to: .now)
            try startPlayback(prepared.buffer, preset: selectedPreset)

            let durationSeconds = Double(sourceBuffer.frameLength) / sourceBuffer.format.sampleRate
            let measurement = ShannonVoiceLabMeasurement(
                presetID: selectedPreset.id,
                processingMilliseconds: Self.milliseconds(processingDuration),
                algorithmLatencyMilliseconds: prepared.algorithmLatencyMilliseconds,
                sourceDurationSeconds: durationSeconds
            )
            measurements.insert(measurement, at: 0)
            if measurements.count > 40 { measurements.removeLast(measurements.count - 40) }
            status = "(selectedPreset.title) を再生中"
        }
    }

    public func selectCustomPreset() {
        selectedPreset = .custom(
            pitchCents: customPitchCents,
            formantSemitones: customFormantSemitones
        )
    }

    public func previewCustomPreset() async {
        selectCustomPreset()
        await playSelectedPreset()
    }

    public func resetCustomTuning() {
        stopPlayback()
        customPitchCents = ShannonVoiceLabTuning.defaultPitchCents
        customFormantSemitones = ShannonVoiceLabTuning.defaultFormantSemitones
        selectCustomPreset()
        status = "Shannon候補値へ戻しました"
    }

    public func beginCustomAdjustment() {
        stopPlayback()
        selectCustomPreset()
        status = "値を調整中です"
    }

    public func stopPlayback() {
        player.stop()
        engine.stop()
        engine.reset()
        isPlaying = false
    }

    public func clearMeasurements() {
        measurements.removeAll()
    }

    private func prepareForPlayback(
        _ source: AVAudioPCMBuffer,
        preset: ShannonVoiceLabPreset
    ) async throws -> ShannonVoiceLabProcessedBuffer {
        switch preset.kind {
        case .bypass, .appleTimePitch:
            let latency = preset.kind == .appleTimePitch ? timePitch.auAudioUnit.latency * 1_000 : 0
            return ShannonVoiceLabProcessedBuffer(
                buffer: source,
                algorithmLatencyMilliseconds: latency
            )
        case .signalsmith:
            return try ShannonVoiceLabSignalProcessor.process(
                source,
                pitchCents: preset.pitchCents,
                formantSemitones: preset.formantSemitones
            )
        case .rvc:
            let wav = try Self.wavData(from: source)
            var configuration = rvcConfiguration
            configuration.pitchShiftSemitones = 0
            let converted = try await rvcClient.convert(wavData: wav, configuration: configuration)
            let convertedBuffer = try Self.readPCM(data: converted)
            return ShannonVoiceLabProcessedBuffer(
                buffer: convertedBuffer,
                algorithmLatencyMilliseconds: 0
            )
        }
    }

    private func startPlayback(
        _ buffer: AVAudioPCMBuffer,
        preset: ShannonVoiceLabPreset
    ) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)

        engine.disconnectNodeOutput(player)
        engine.disconnectNodeOutput(timePitch)
        engine.disconnectNodeOutput(equalizer)
        engine.connect(player, to: timePitch, format: buffer.format)
        engine.connect(timePitch, to: equalizer, format: buffer.format)
        engine.connect(equalizer, to: engine.mainMixerNode, format: buffer.format)

        if preset.kind == .appleTimePitch || preset.kind == .rvc {
            timePitch.pitch = preset.pitchCents
            timePitch.rate = preset.rate
        } else {
            timePitch.pitch = 0
            timePitch.rate = 1
        }
        let usesFinish = preset.kind != .bypass
        equalizer.bands[0].gain = usesFinish ? 1.2 : 0
        equalizer.bands[1].gain = usesFinish ? -0.8 : 0
        equalizer.globalGain = preset.outputGainDB
        player.volume = 1

        player.scheduleBuffer(buffer, at: nil, options: []) { [weak self] in
            Task { @MainActor in
                self?.isPlaying = false
                self?.status = "比較できます"
            }
        }
        engine.prepare()
        try engine.start()
        player.play()
        isPlaying = true
    }

    private func synthesizeFixedJapanese() async throws -> URL {
        let url = Self.temporaryURL(extension: "wav")
        let writer = ShannonVoiceLabSpeechWriter(url: url)
        speechWriter = writer
        let utterance = AVSpeechUtterance(string: ShannonVoiceLabEvaluationScript.japanese)
        utterance.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        utterance.rate = 0.48
        utterance.pitchMultiplier = 1
        defer { speechWriter = nil }
        return try await withCheckedThrowingContinuation { continuation in
            writer.begin(continuation: continuation)
            speechSynthesizer.write(utterance) { buffer in
                writer.receive(buffer)
            }
        }
    }

    private func configureEffectDefaults() {
        let highShelf = equalizer.bands[0]
        highShelf.filterType = .highShelf
        highShelf.frequency = 3_200
        highShelf.bandwidth = 0.7
        highShelf.bypass = false

        let lowShelf = equalizer.bands[1]
        lowShelf.filterType = .lowShelf
        lowShelf.frequency = 180
        lowShelf.bandwidth = 0.7
        lowShelf.bypass = false

    }

    private func performBusyAction(_ action: () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await action()
        } catch {
            errorMessage = error.localizedDescription
            status = "実行できませんでした"
        }
    }

    private static func readPCM(from url: URL) throws -> AVAudioPCMBuffer {
        let file = try AVAudioFile(forReading: url)
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: file.processingFormat,
            frameCapacity: AVAudioFrameCount(file.length)
        ) else {
            throw ShannonVoiceLabError.unsupportedPCMFormat
        }
        try file.read(into: buffer)
        return buffer
    }

    private static func readPCM(data: Data) throws -> AVAudioPCMBuffer {
        let url = temporaryURL(extension: "wav")
        try data.write(to: url, options: .atomic)
        defer { try? FileManager.default.removeItem(at: url) }
        return try readPCM(from: url)
    }

    private static func wavData(from buffer: AVAudioPCMBuffer) throws -> Data {
        let url = temporaryURL(extension: "wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: buffer.format.sampleRate,
            AVNumberOfChannelsKey: buffer.format.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let file = try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
        try file.write(from: buffer)
        return try Data(contentsOf: url)
    }

    private static func temporaryURL(extension fileExtension: String) -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "shannon-voice-lab-\(UUID().uuidString)")
            .appendingPathExtension(fileExtension)
    }

    private static func durationLabel(_ buffer: AVAudioPCMBuffer?) -> String {
        guard let buffer else { return "0.0秒" }
        return String(format: "%.1f秒", Double(buffer.frameLength) / buffer.format.sampleRate)
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        let components = duration.components
        return Double(components.seconds) * 1_000
            + Double(components.attoseconds) / 1_000_000_000_000_000
    }
}

private final class ShannonVoiceLabSpeechWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private var continuation: CheckedContinuation<URL, any Error>?
    private var file: AVAudioFile?
    private var finished = false

    init(url: URL) {
        self.url = url
    }

    func begin(continuation: CheckedContinuation<URL, any Error>) {
        lock.withLock { self.continuation = continuation }
    }

    func receive(_ buffer: AVAudioBuffer) {
        lock.withLock {
            guard !finished, let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                finished = true
                file = nil
                let savedContinuation = continuation
                continuation = nil
                savedContinuation?.resume(returning: url)
                return
            }
            do {
                if file == nil {
                    file = try AVAudioFile(forWriting: url, settings: pcm.format.settings)
                }
                try file?.write(from: pcm)
            } catch {
                finished = true
                file = nil
                let savedContinuation = continuation
                continuation = nil
                savedContinuation?.resume(throwing: error)
            }
        }
    }
}
#endif
