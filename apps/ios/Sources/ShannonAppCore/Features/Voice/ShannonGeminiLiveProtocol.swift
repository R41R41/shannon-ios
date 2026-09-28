import Foundation

public enum ShannonGeminiLiveServerEvent: Equatable, Sendable {
    case setupComplete
    case interimInputTranscript(String)
    case inputTranscript(String)
    case turnComplete
    case sessionHandle(String)
    case goAway(String?)
}

public enum ShannonGeminiLiveProtocol {
    public static let endpoint = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
    public static let customVocabulary = [
        "シャノン", "ライ",
        "Aether", "エーテル",
        "Voyager", "ボイジャー",
        "Syzygy", "Jev", "Minebot", "Codex", "SwiftUI", "TestFlight",
    ]

    public static func webSocketURL(token: String) throws -> URL {
        guard var components = URLComponents(string: endpoint), !token.isEmpty else {
            throw URLError(.badURL)
        }
        components.queryItems = [URLQueryItem(name: "access_token", value: token)]
        guard let url = components.url else { throw URLError(.badURL) }
        return url
    }

    public static func setupMessage(
        session: ShannonGeminiLiveSessionDTO,
        resumptionHandle: String? = nil
    ) throws -> Data {
        var setup: [String: Any] = [
            "model": "models/\(session.model)",
            "generationConfig": [
                "responseModalities": ["TEXT"],
            ],
            "inputAudioTranscription": [
                "languageCodes": ["ja-JP"],
                "customVocabulary": customVocabulary,
            ],
            "realtimeInputConfig": [
                "automaticActivityDetection": [
                    "disabled": false,
                    "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
                    "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
                    "prefixPaddingMs": 80,
                    "silenceDurationMs": 360,
                ],
            ],
            "sessionResumption": resumptionHandle.map { ["handle": $0] } ?? [:],
        ]
        // Keep the empty object for a new resumable session; only replace it when reconnecting.
        if let resumptionHandle { setup["sessionResumption"] = ["handle": resumptionHandle] }
        return try JSONSerialization.data(withJSONObject: ["setup": setup])
    }

    public static func audioMessage(_ pcm16: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "realtimeInput": [
                "audio": [
                    "data": pcm16.base64EncodedString(),
                    "mimeType": "audio/pcm;rate=16000",
                ],
            ],
        ])
    }

    public static func audioStreamEndMessage() throws -> Data {
        try JSONSerialization.data(withJSONObject: ["realtimeInput": ["audioStreamEnd": true]])
    }

    public static func events(from data: Data) throws -> [ShannonGeminiLiveServerEvent] {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        var events: [ShannonGeminiLiveServerEvent] = []
        if root["setupComplete"] != nil { events.append(.setupComplete) }
        if let update = root["sessionResumptionUpdate"] as? [String: Any],
           update["resumable"] as? Bool == true,
           let handle = update["newHandle"] as? String,
           !handle.isEmpty {
            events.append(.sessionHandle(handle))
        }
        if let goAway = root["goAway"] as? [String: Any] {
            events.append(.goAway(goAway["timeLeft"] as? String))
        }
        guard let content = root["serverContent"] as? [String: Any] else { return events }
        if let transcript = (content["interimInputTranscription"] as? [String: Any])?["text"] as? String,
           !transcript.isEmpty { events.append(.interimInputTranscript(transcript)) }
        if let transcript = (content["inputTranscription"] as? [String: Any])?["text"] as? String,
           !transcript.isEmpty { events.append(.inputTranscript(transcript)) }
        if content["turnComplete"] as? Bool == true { events.append(.turnComplete) }
        return events
    }
}

public enum ShannonGeminiLivePCM {
    public static func pcm16Mono16k(
        samples: UnsafeBufferPointer<Float>,
        sampleRate: Double,
        stride: Int = 1
    ) -> Data {
        guard !samples.isEmpty, sampleRate.isFinite, sampleRate > 0, stride > 0 else { return Data() }
        let inputFrameCount = samples.count / stride
        guard inputFrameCount > 0 else { return Data() }
        let outputCount = max(1, Int((Double(inputFrameCount) * 16_000 / sampleRate).rounded(.down)))
        var output = Data(count: outputCount * MemoryLayout<Int16>.size)
        output.withUnsafeMutableBytes { rawBuffer in
            guard let destination = rawBuffer.bindMemory(to: Int16.self).baseAddress else { return }
            let scale = sampleRate / 16_000
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
    static let chunkByteCount = 1_600 * MemoryLayout<Int16>.size

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
        lock.withLock { pending.removeAll(keepingCapacity: true) }
    }
}
