import Foundation
#if canImport(AVFoundation)
@preconcurrency import AVFoundation
#endif

/// The level of the speech the app is playing, for her mouth. A playback path hands it the
/// samples it plays (one line: `observe(_:)` on its player node, or `publish(rms:)`), and
/// whoever draws her takes the level from `sink`. With no sink nothing is computed.
///
/// The rule is the desktop body's: the root mean square of the samples × 5, capped at 1,
/// and 0 when speech ends.
public final class ShannonSpeechLevelPublisher: @unchecked Sendable {
    public typealias Sink = @MainActor @Sendable (Double) -> Void

    public static let shared = ShannonSpeechLevelPublisher()

    /// About one value per drawn frame of a 30 fps mouth.
    static let windowSeconds = 1.0 / 30.0
    /// With no samples for this long after the last ones, the mouth closes.
    static let silenceAfterSeconds = 0.15

    private let lock = NSLock()
    private var sink: Sink?
    private var sequence: UInt64 = 0
#if canImport(AVFoundation)
    private weak var observed: AVAudioNode?
    private var observedBus: AVAudioNodeBus = 0
    private var tapped = false
#endif

    public init() {}

    public static func mouthLevel(rms: Float) -> Double {
        guard rms.isFinite, rms > 0 else { return 0 }
        return min(1, Double(rms) * 5)
    }

    /// The root mean square of each window of `windowFrames` samples.
    static func windowedRMS(_ samples: UnsafeBufferPointer<Float>, windowFrames: Int) -> [Float] {
        guard !samples.isEmpty, windowFrames > 0 else { return [] }
        var levels: [Float] = []
        levels.reserveCapacity(samples.count / windowFrames + 1)
        var start = 0
        while start < samples.count {
            let end = min(samples.count, start + windowFrames)
            var sum: Float = 0
            for index in start..<end { sum += samples[index] * samples[index] }
            levels.append((sum / Float(end - start)).squareRoot())
            start = end
        }
        return levels
    }

    public func setSink(_ sink: Sink?) {
        lock.lock()
        self.sink = sink
        sequence &+= 1
        lock.unlock()
#if canImport(AVFoundation)
        syncTap()
#endif
    }

    /// One level now. For a playback path that already measures its output.
    public func publish(rms: Float) {
        deliver(levels: [rms], windowSeconds: 0)
    }

    /// Speech ended or was cut off: the mouth closes at once.
    public func end() {
        lock.lock()
        sequence &+= 1
        let sink = sink
        lock.unlock()
        guard let sink else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { sink(0) } }
    }

    /// Levels of consecutive windows, shown one after another, then silence unless more arrive.
    private func deliver(levels: [Float], windowSeconds: Double) {
        lock.lock()
        guard let sink, !levels.isEmpty else {
            lock.unlock()
            return
        }
        sequence &+= 1
        let current = sequence
        lock.unlock()
        for (index, level) in levels.enumerated() {
            let value = Self.mouthLevel(rms: level)
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(index) * windowSeconds) { [weak self] in
                guard let self, self.isCurrent(current) || index == 0 else { return }
                MainActor.assumeIsolated { sink(value) }
            }
        }
        let silenceAt = Double(levels.count) * windowSeconds + Self.silenceAfterSeconds
        DispatchQueue.main.asyncAfter(deadline: .now() + silenceAt) { [weak self] in
            guard let self, self.isCurrent(current) else { return }
            MainActor.assumeIsolated { sink(0) }
        }
    }

    private func isCurrent(_ value: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return sequence == value && sink != nil
    }

    private var hasSink: Bool {
        lock.lock()
        defer { lock.unlock() }
        return sink != nil
    }

#if canImport(AVFoundation)
    /// Remembers the player node of the playback path. Its output is tapped only while somebody draws a
    /// mouth from it: with the default form the call's audio graph is exactly what it was.
    /// Call on the main thread (the transports build their graph there).
    public func observe(_ node: AVAudioNode, bus: AVAudioNodeBus = 0) {
        lock.lock()
        let previous = observed
        let wasTapped = tapped
        observed = node
        observedBus = bus
        tapped = false
        lock.unlock()
        if wasTapped, let previous, previous !== node { previous.removeTap(onBus: bus) }
        syncTap()
    }

    private func syncTap() {
        lock.lock()
        let node = observed
        let bus = observedBus
        let wanted = sink != nil && node != nil
        let change = wanted != tapped
        tapped = wanted
        lock.unlock()
        guard change, let node else { return }
        node.removeTap(onBus: bus)
        if wanted { node.installTap(onBus: bus, bufferSize: 1_024, format: nil, block: Self.makeTap(self)) }
    }

    /// Built outside any actor so the block carries no isolation onto the audio thread.
    nonisolated private static func makeTap(_ publisher: ShannonSpeechLevelPublisher) -> AVAudioNodeTapBlock {
        { buffer, _ in publisher.ingest(buffer) }
    }

    func ingest(_ buffer: AVAudioPCMBuffer) {
        guard hasSink, buffer.frameLength > 0, buffer.format.sampleRate > 0 else { return }
        let frames = Int(buffer.frameLength)
        let windowFrames = max(1, Int(buffer.format.sampleRate * Self.windowSeconds))
        let levels: [Float]
        if let channel = buffer.floatChannelData?[0] {
            levels = Self.windowedRMS(UnsafeBufferPointer(start: channel, count: frames), windowFrames: windowFrames)
        } else if let channel = buffer.int16ChannelData?[0] {
            let scaled = UnsafeBufferPointer(start: channel, count: frames).map { Float($0) / Float(Int16.max) }
            levels = scaled.withUnsafeBufferPointer { Self.windowedRMS($0, windowFrames: windowFrames) }
        } else {
            return
        }
        deliver(levels: levels, windowSeconds: Double(windowFrames) / buffer.format.sampleRate)
    }
#endif
}
