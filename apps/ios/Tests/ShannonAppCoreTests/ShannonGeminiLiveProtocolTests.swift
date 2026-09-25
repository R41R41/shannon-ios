import XCTest
@testable import ShannonAppCore

final class ShannonGeminiLiveProtocolTests: XCTestCase {
    func testSetupUsesEphemeralSessionVoiceTranscriptionsCompressionAndTool() throws {
        let session = ShannonGeminiLiveSessionDTO(
            token: "auth_tokens/temporary",
            model: "gemini-3.8-live",
            voice: "Aoede",
            threadId: "thread-a",
            instructions: "あなたはシャノン。",
            expiresAt: "2026-09-25T03:20:00.000Z",
            inputUsdPerMinute: 0.005,
            outputUsdPerMinute: 0.018
        )
        let data = try ShannonGeminiLiveProtocol.setupMessage(session: session)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let setup = try XCTUnwrap(root["setup"] as? [String: Any])
        XCTAssertEqual(setup["model"] as? String, "models/gemini-3.8-live")
        let generation = try XCTUnwrap(setup["generationConfig"] as? [String: Any])
        XCTAssertEqual(generation["responseModalities"] as? [String], ["AUDIO"])
        let speech = try XCTUnwrap(generation["speechConfig"] as? [String: Any])
        let voice = try XCTUnwrap(speech["voiceConfig"] as? [String: Any])
        let prebuilt = try XCTUnwrap(voice["prebuiltVoiceConfig"] as? [String: String])
        XCTAssertEqual(prebuilt["voiceName"], "Aoede")
        XCTAssertNotNil(setup["inputAudioTranscription"])
        XCTAssertNotNil(setup["outputAudioTranscription"])
        let realtime = try XCTUnwrap(setup["realtimeInputConfig"] as? [String: Any])
        let detection = try XCTUnwrap(realtime["automaticActivityDetection"] as? [String: Any])
        XCTAssertEqual(detection["silenceDurationMs"] as? Int, 600)
        XCTAssertEqual(realtime["activityHandling"] as? String, "START_OF_ACTIVITY_INTERRUPTS")
        XCTAssertNotNil(setup["contextWindowCompression"])
        XCTAssertNotNil(setup["sessionResumption"])
        let tools = try XCTUnwrap(setup["tools"] as? [[String: Any]])
        let functions = try XCTUnwrap(tools.first?["functionDeclarations"] as? [[String: Any]])
        XCTAssertEqual(functions.first?["name"] as? String, "consult_shannon_backend")
        XCTAssertEqual(functions.first?["behavior"] as? String, "NON_BLOCKING")
    }

    func testServerEventsDecodeAudioTranscriptsInterruptionToolAndTurn() throws {
        let audio = Data([0, 1, 2, 3])
        let message: [String: Any] = [
            "toolCall": [
                "functionCalls": [[
                    "id": "call-1",
                    "name": "consult_shannon_backend",
                    "args": ["request": "明日の天気を調べて"],
                ]],
            ],
            "serverContent": [
                "interrupted": true,
                "inputTranscription": ["text": "明日は"],
                "outputTranscription": ["text": "調べるね"],
                "modelTurn": [
                    "parts": [[
                        "inlineData": [
                            "mimeType": "audio/pcm;rate=24000",
                            "data": audio.base64EncodedString(),
                        ],
                    ]],
                ],
                "turnComplete": true,
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: message)
        XCTAssertEqual(try ShannonGeminiLiveProtocol.events(from: data), [
            .toolCall(id: "call-1", request: "明日の天気を調べて"),
            .interrupted,
            .inputTranscript("明日は"),
            .outputTranscript("調べるね"),
            .audio(audio),
            .turnComplete,
        ])
    }

    func testPCMResamplesToSixteenKilohertzAndClamps() {
        let samples: [Float] = [-2, -1, 0, 1, 2, 0]
        let data = samples.withUnsafeBufferPointer {
            ShannonGeminiLivePCM.pcm16Mono16k(samples: $0, sampleRate: 48_000)
        }
        XCTAssertEqual(data.count, 4)
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertEqual(values.count, 2)
        XCTAssertEqual(values[0], Int16.min + 1)
        XCTAssertEqual(values[1], Int16.max)
    }

    func testPCMRootMeanSquareReadsGeminiPlaybackSamples() {
        let samples: [Int16] = [0, Int16.max, 0, -Int16.max]
        let data = samples.withUnsafeBytes { Data($0) }
        XCTAssertEqual(
            ShannonGeminiLivePCM.rootMeanSquare(pcm16: data),
            Float(0.5.squareRoot()),
            accuracy: 0.0001
        )
    }

    func testAudioChunkerEmitsHundredMillisecondChunks() {
        let chunker = ShannonGeminiLiveAudioChunker()
        XCTAssertTrue(chunker.append(Data(repeating: 1, count: 1_200)).isEmpty)

        let chunks = chunker.append(Data(repeating: 2, count: 5_600))
        XCTAssertEqual(chunks.map(\.count), [3_200, 3_200])
        XCTAssertEqual(chunks[0].prefix(1_200), Data(repeating: 1, count: 1_200))

        chunker.reset()
        XCTAssertTrue(chunker.append(Data(repeating: 3, count: 3_199)).isEmpty)
        XCTAssertEqual(chunker.append(Data(repeating: 4, count: 1)).first?.count, 3_200)
    }
}
