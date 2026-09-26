import Foundation

#if os(iOS) && canImport(WebRTC)
@preconcurrency import AVFoundation
#endif

struct ShannonVoiceAudioLevelEnvelope: Equatable, Sendable {
    private(set) var value: Float = 0

    mutating func ingest(linearRMS: Float) -> Float {
        let finiteRMS = linearRMS.isFinite ? max(0, linearRMS) : 0
        let decibels = 20 * log10(max(finiteRMS, 0.000_001))
        let normalized = min(1, max(0, (decibels + 55) / 43))
        let gated = normalized < 0.035 ? 0 : pow(normalized, 0.78)
        let response: Float = gated > value ? 0.44 : 0.10
        value += (gated - value) * response
        return value
    }

    mutating func reset() {
        value = 0
    }
}

#if os(iOS) && canImport(WebRTC)
final class ShannonVoiceAudioLevelSampler: @unchecked Sendable {
    var onLevel: (@Sendable (Float) -> Void)?

    private var envelope = ShannonVoiceAudioLevelEnvelope()
    private var framesSincePublish: AVAudioFrameCount = 0

    func receive(
        _ audioBufferList: UnsafePointer<AudioBufferList>,
        frameCount: AVAudioFrameCount,
        format: AVAudioFormat
    ) {
        let linearRMS = Self.linearRMS(audioBufferList, format: format)
        let level = envelope.ingest(linearRMS: linearRMS)
        framesSincePublish &+= frameCount
        let publishInterval = AVAudioFrameCount(max(1, format.sampleRate / 30))
        guard framesSincePublish >= publishInterval else { return }
        framesSincePublish %= publishInterval
        onLevel?(level)
    }

    func reset() {
        envelope.reset()
        framesSincePublish = 0
        onLevel?(0)
    }

    private static func linearRMS(
        _ audioBufferList: UnsafePointer<AudioBufferList>,
        format: AVAudioFormat
    ) -> Float {
        let mutableList = UnsafeMutablePointer(mutating: audioBufferList)
        let buffers = UnsafeMutableAudioBufferListPointer(mutableList)
        var sum: Double = 0
        var sampleCount = 0

        for buffer in buffers {
            guard let data = buffer.mData, buffer.mDataByteSize > 0 else { continue }
            switch format.commonFormat {
            case .pcmFormatFloat32:
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                let samples = data.assumingMemoryBound(to: Float.self)
                for index in 0..<count {
                    let sample = Double(samples[index])
                    sum += sample * sample
                }
                sampleCount += count
            case .pcmFormatFloat64:
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Double>.size
                let samples = data.assumingMemoryBound(to: Double.self)
                for index in 0..<count {
                    let sample = samples[index]
                    sum += sample * sample
                }
                sampleCount += count
            case .pcmFormatInt16:
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size
                let samples = data.assumingMemoryBound(to: Int16.self)
                for index in 0..<count {
                    let sample = Double(samples[index]) / Double(Int16.max)
                    sum += sample * sample
                }
                sampleCount += count
            case .pcmFormatInt32:
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Int32>.size
                let samples = data.assumingMemoryBound(to: Int32.self)
                for index in 0..<count {
                    let sample = Double(samples[index]) / Double(Int32.max)
                    sum += sample * sample
                }
                sampleCount += count
            case .otherFormat:
                continue
            @unknown default:
                continue
            }
        }

        guard sampleCount > 0 else { return 0 }
        return Float(sqrt(sum / Double(sampleCount)))
    }
}
#endif
