import AVFoundation
import Foundation
import ShannonVoiceDSP

struct ShannonVoiceLabProcessedBuffer {
    let buffer: AVAudioPCMBuffer
    let algorithmLatencyMilliseconds: Double
}

enum ShannonVoiceLabSignalProcessor {
    static func process(
        _ source: AVAudioPCMBuffer,
        pitchCents: Float,
        formantSemitones: Float
    ) throws -> ShannonVoiceLabProcessedBuffer {
        guard source.format.commonFormat == .pcmFormatFloat32,
              !source.format.isInterleaved,
              let sourceChannels = source.floatChannelData else {
            throw ShannonVoiceLabError.unsupportedPCMFormat
        }

        let frameCount = Int(source.frameLength)
        let channelCount = Int(source.format.channelCount)
        guard frameCount > 0, (1...2).contains(channelCount) else {
            throw ShannonVoiceLabError.unsupportedPCMFormat
        }

        var interleavedInput = [Float](repeating: 0, count: frameCount * channelCount)
        for channel in 0..<channelCount {
            let channelData = sourceChannels[channel]
            for frame in 0..<frameCount {
                interleavedInput[frame * channelCount + channel] = channelData[frame]
            }
        }

        var interleavedOutput = [Float](repeating: 0, count: interleavedInput.count)
        var latency = ShannonVoiceDSPLatency(
            input_latency_samples: 0,
            output_latency_samples: 0
        )
        let succeeded = interleavedInput.withUnsafeBufferPointer { input in
            interleavedOutput.withUnsafeMutableBufferPointer { output in
                shannon_voice_dsp_process(
                    input.baseAddress,
                    Int32(frameCount),
                    Int32(channelCount),
                    source.format.sampleRate,
                    pitchCents / 100,
                    formantSemitones,
                    output.baseAddress,
                    &latency
                )
            }
        }
        guard succeeded,
              let output = AVAudioPCMBuffer(
                pcmFormat: source.format,
                frameCapacity: AVAudioFrameCount(frameCount)
              ),
              let outputChannels = output.floatChannelData else {
            throw ShannonVoiceLabError.processingFailed
        }
        output.frameLength = AVAudioFrameCount(frameCount)

        for channel in 0..<channelCount {
            let channelData = outputChannels[channel]
            for frame in 0..<frameCount {
                channelData[frame] = interleavedOutput[frame * channelCount + channel]
            }
        }

        let latencySamples = latency.input_latency_samples + latency.output_latency_samples
        let latencyMilliseconds = Double(latencySamples) / source.format.sampleRate * 1_000
        return ShannonVoiceLabProcessedBuffer(
            buffer: output,
            algorithmLatencyMilliseconds: latencyMilliseconds
        )
    }
}

enum ShannonVoiceLabError: LocalizedError {
    case noSource
    case unsupportedPCMFormat
    case processingFailed
    case speechSynthesisFailed
    case invalidEndpoint
    case invalidRVCResponse
    case realtimeRequiresLiveSession

    var errorDescription: String? {
        switch self {
        case .noSource: "先に評価音声を準備してください。"
        case .unsupportedPCMFormat: "このPCM形式はVoice Labで扱えません。"
        case .processingFailed: "音声加工に失敗しました。"
        case .speechSynthesisFailed: "固定の日本語音声を生成できませんでした。"
        case .invalidEndpoint: "RVC endpointのURLを確認してください。"
        case .invalidRVCResponse: "RVC endpointからWAVを受け取れませんでした。"
        case .realtimeRequiresLiveSession: "GPT-Live経路は音声セッションから開始してください。"
        }
    }
}
