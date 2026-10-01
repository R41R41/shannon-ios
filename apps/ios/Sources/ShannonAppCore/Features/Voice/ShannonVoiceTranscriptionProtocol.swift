import Foundation

/// Events from the OpenAI Realtime transcription session, reduced to what the
/// voice session needs. Transcript deltas are intentionally not surfaced: Shannon
/// shows no live caption, and a final transcript is the only text that reaches the model.
public enum ShannonTranscriptionEvent: Equatable, Sendable {
    case sessionReady
    case speechStarted
    case speechStopped
    case inputTranscript(String)
    case goAway(String?)
}

/// The session's language, vocabulary and turn detection are fixed by the server-minted
/// client secret, so the app only connects, streams 24 kHz PCM, and reads transcripts.
public enum ShannonOpenAITranscriptionProtocol {
    public static let endpoint = "wss://api.openai.com/v1/realtime?intent=transcription"
    public static let sampleRate = 24_000
    public static let acceptedModels: Set<String> = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]

    public static func webSocketRequest(token: String) throws -> URLRequest {
        guard let url = URL(string: endpoint), token.hasPrefix("ek_"), token.count <= 512 else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    public static func audioMessage(_ pcm16: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "type": "input_audio_buffer.append",
            "audio": pcm16.base64EncodedString(),
        ])
    }

    public static func events(from data: Data) throws -> [ShannonTranscriptionEvent] {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = root["type"] as? String else { return [] }
        switch type {
        case "session.created":
            return [.sessionReady]
        case "input_audio_buffer.speech_started":
            return [.speechStarted]
        case "input_audio_buffer.speech_stopped":
            return [.speechStopped]
        case "conversation.item.input_audio_transcription.completed":
            let transcript = (root["transcript"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return transcript.isEmpty ? [] : [.inputTranscript(transcript)]
        default:
            return []
        }
    }
}

public enum ShannonGeminiLivePCM {
    public static func pcm16Mono(
        samples: UnsafeBufferPointer<Float>,
        sampleRate: Double,
        outputSampleRate: Double = Double(ShannonOpenAITranscriptionProtocol.sampleRate),
        stride: Int = 1
    ) -> Data {
        guard !samples.isEmpty, sampleRate.isFinite, sampleRate > 0, outputSampleRate > 0, stride > 0 else { return Data() }
        let inputFrameCount = samples.count / stride
        guard inputFrameCount > 0 else { return Data() }
        let outputCount = max(1, Int((Double(inputFrameCount) * outputSampleRate / sampleRate).rounded(.down)))
        var output = Data(count: outputCount * MemoryLayout<Int16>.size)
        output.withUnsafeMutableBytes { rawBuffer in
            guard let destination = rawBuffer.bindMemory(to: Int16.self).baseAddress else { return }
            let scale = sampleRate / outputSampleRate
            for index in 0..<outputCount {
                let sourcePosition = Double(index) * scale
                let lower = min(inputFrameCount - 1, Int(sourcePosition))
                let upper = min(inputFrameCount - 1, lower + 1)
                let fraction = Float(sourcePosition - Double(lower))
                let lowerSample = samples[lower * stride]
                let upperSample = samples[upper * stride]
                let sample = lowerSample + (upperSample - lowerSample) * fraction
                let clamped = max(-1, min(1, sample))
                destination[index] = Int16((clamped * Float(Int16.max)).rounded())
            }
        }
        return output
    }

    public static func rootMeanSquare(
        samples: UnsafeBufferPointer<Float>,
        stride: Int = 1
    ) -> Float {
        guard !samples.isEmpty, stride > 0 else { return 0 }
        let frameCount = samples.count / stride
        guard frameCount > 0 else { return 0 }
        var sum: Float = 0
        for frame in 0..<frameCount {
            let sample = samples[frame * stride]
            sum += sample * sample
        }
        return sqrt(sum / Float(frameCount))
    }

    public static func rootMeanSquare(pcm16 data: Data) -> Float {
        guard data.count >= MemoryLayout<Int16>.size else { return 0 }
        return data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            guard !samples.isEmpty else { return 0 }
            var sum: Double = 0
            for sample in samples {
                let normalized = Double(sample) / Double(Int16.max)
                sum += normalized * normalized
            }
            return Float(sqrt(sum / Double(samples.count)))
        }
    }
}

final class ShannonGeminiLiveAudioChunker: @unchecked Sendable {
    /// 100 ms of 24 kHz mono PCM16.
    static let chunkByteCount = 2_400 * MemoryLayout<Int16>.size

    private let lock = NSLock()
    private var pending = Data()

    func append(_ pcm: Data) -> [Data] {
        guard !pcm.isEmpty else { return [] }
        return lock.withLock {
            pending.append(pcm)
            var chunks: [Data] = []
            while pending.count >= Self.chunkByteCount {
                chunks.append(Data(pending.prefix(Self.chunkByteCount)))
                pending.removeFirst(Self.chunkByteCount)
            }
            return chunks
        }
    }

    func reset() {
        // removeAll(keepingCapacity:) traps on a fully drained Data whose startIndex has advanced.
        lock.withLock { pending = Data() }
    }
}
