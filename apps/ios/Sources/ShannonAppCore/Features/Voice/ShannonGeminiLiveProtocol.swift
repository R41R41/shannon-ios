import Foundation

public enum ShannonGeminiLiveServerEvent: Equatable, Sendable {
    case setupComplete
    case audio(Data)
    case inputTranscript(String)
    case outputTranscript(String)
    case interrupted
    case turnComplete
    case toolCall(id: String, request: String)
    case sessionHandle(String)
    case goAway(String?)
}

public enum ShannonGeminiLiveProtocol {
    public static let endpoint = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"

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
                "responseModalities": ["AUDIO"],
                "speechConfig": [
                    "voiceConfig": [
                        "prebuiltVoiceConfig": ["voiceName": session.voice],
                    ],
                ],
            ],
            "systemInstruction": [
                "parts": [[
                    "text": session.instructions + "\n\nRESPOND IN JAPANESE. YOU MUST RESPOND UNMISTAKABLY IN JAPANESE.",
                ]],
            ],
            "inputAudioTranscription": [:],
            "outputAudioTranscription": [:],
            "realtimeInputConfig": [
                "automaticActivityDetection": [
                    "disabled": false,
                    "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
                    "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
                    "prefixPaddingMs": 80,
                    "silenceDurationMs": 600,
                ],
                "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
            ],
            "contextWindowCompression": ["slidingWindow": [:]],
            "sessionResumption": resumptionHandle.map { ["handle": $0] } ?? [:],
            "tools": [[
                "functionDeclarations": [[
                    "name": "consult_shannon_backend",
                    "description": "Use for current facts, relevant memories, exact time or location, weather, transit, project records, notes, tasks, and any request that needs Shannon's verified backend. Never invent a tool result.",
                    "behavior": "NON_BLOCKING",
                    "parameters": [
                        "type": "OBJECT",
                        "properties": [
                            "request": [
                                "type": "STRING",
                                "description": "The complete request in Japanese, including corrected names and constraints.",
                            ],
                        ],
                        "required": ["request"],
                    ],
                ]],
            ]],
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

    public static func toolResponseMessage(id: String, result: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "toolResponse": [
                "functionResponses": [[
                    "id": id,
                    "name": "consult_shannon_backend",
                    "response": [
                        "result": result,
                        "scheduling": "WHEN_IDLE",
                    ],
                ]],
            ],
        ])
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
        if let calls = (root["toolCall"] as? [String: Any])?["functionCalls"] as? [[String: Any]] {
            for call in calls where call["name"] as? String == "consult_shannon_backend" {
                guard let id = call["id"] as? String,
                      let args = call["args"] as? [String: Any],
                      let request = args["request"] as? String,
                      !request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                events.append(.toolCall(id: id, request: request))
            }
        }
        guard let content = root["serverContent"] as? [String: Any] else { return events }
        if content["interrupted"] as? Bool == true { events.append(.interrupted) }
        if let transcript = (content["inputTranscription"] as? [String: Any])?["text"] as? String,
           !transcript.isEmpty { events.append(.inputTranscript(transcript)) }
        if let transcript = (content["outputTranscription"] as? [String: Any])?["text"] as? String,
           !transcript.isEmpty { events.append(.outputTranscript(transcript)) }
        if let parts = (content["modelTurn"] as? [String: Any])?["parts"] as? [[String: Any]] {
            for part in parts {
                guard let inline = part["inlineData"] as? [String: Any],
                      let mimeType = inline["mimeType"] as? String,
                      mimeType.lowercased().hasPrefix("audio/pcm"),
                      let encoded = inline["data"] as? String,
                      let audio = Data(base64Encoded: encoded),
                      !audio.isEmpty else { continue }
                events.append(.audio(audio))
            }
        }
        if content["turnComplete"] as? Bool == true { events.append(.turnComplete) }
        return events
    }
}

public enum ShannonGeminiLivePCM {
    public static func pcm16Mono16k(samples: UnsafeBufferPointer<Float>, sampleRate: Double) -> Data {
        guard !samples.isEmpty, sampleRate.isFinite, sampleRate > 0 else { return Data() }
        let outputCount = max(1, Int((Double(samples.count) * 16_000 / sampleRate).rounded(.down)))
        var output = Data(count: outputCount * MemoryLayout<Int16>.size)
        output.withUnsafeMutableBytes { rawBuffer in
            guard let destination = rawBuffer.bindMemory(to: Int16.self).baseAddress else { return }
            let scale = sampleRate / 16_000
            for index in 0..<outputCount {
                let sourcePosition = Double(index) * scale
                let lower = min(samples.count - 1, Int(sourcePosition))
                let upper = min(samples.count - 1, lower + 1)
                let fraction = Float(sourcePosition - Double(lower))
                let sample = samples[lower] + (samples[upper] - samples[lower]) * fraction
                let clamped = max(-1, min(1, sample))
                destination[index] = Int16((clamped * Float(Int16.max)).rounded())
            }
        }
        return output
    }

    public static func rootMeanSquare(samples: UnsafeBufferPointer<Float>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for sample in samples { sum += sample * sample }
        return sqrt(sum / Float(samples.count))
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
