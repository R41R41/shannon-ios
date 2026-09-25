import XCTest
@testable import ShannonAppCore

final class ShannonGeminiLiveProtocolTests: XCTestCase {
    func testSetupUsesJapaneseTranscriptionOnlySession() throws {
        let session = ShannonGeminiLiveSessionDTO(
            token: "auth_tokens/temporary",
            model: "gemini-3.5-transcribe-live",
            voice: "voice_shannon",
            threadId: "thread-a",
            instructions: "あなたはシャノン。",
            expiresAt: "2026-09-25T03:20:00.000Z",
            inputUsdPerMinute: 0.005,
            outputUsdPerMinute: 0.018
        )
        let data = try ShannonGeminiLiveProtocol.setupMessage(session: session)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let setup = try XCTUnwrap(root["setup"] as? [String: Any])
        XCTAssertEqual(setup["model"] as? String, "models/gemini-3.5-transcribe-live")
        let generation = try XCTUnwrap(setup["generationConfig"] as? [String: Any])
        XCTAssertEqual(generation["responseModalities"] as? [String], ["TEXT"])
        let transcription = try XCTUnwrap(setup["inputAudioTranscription"] as? [String: Any])
        XCTAssertEqual(transcription["languageCodes"] as? [String], ["ja-JP"])
        let realtime = try XCTUnwrap(setup["realtimeInputConfig"] as? [String: Any])
        let detection = try XCTUnwrap(realtime["automaticActivityDetection"] as? [String: Any])
        XCTAssertEqual(detection["silenceDurationMs"] as? Int, 360)
        XCTAssertNotNil(setup["sessionResumption"])
        XCTAssertNil(setup["speechConfig"])
        XCTAssertNil(setup["tools"])
    }

    func testServerEventsDecodeInterimFinalTranscriptAndTurn() throws {
        let message: [String: Any] = [
            "serverContent": [
                "interimInputTranscription": ["text": "明日"],
                "inputTranscription": ["text": "明日は"],
                "turnComplete": true,
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: message)
        XCTAssertEqual(try ShannonGeminiLiveProtocol.events(from: data), [
            .interimInputTranscript("明日"),
            .inputTranscript("明日は"),
            .turnComplete,
        ])
    }

    func testCascadeSpeechSegmentsAndAdaptsStyle() {
        XCTAssertEqual(
            ShannonGeminiCascadeSpeech.segments("よし！ 任せてください。大丈夫？"),
            ["よし！", "任せてください。", "大丈夫？"]
        )
        XCTAssertTrue(ShannonGeminiCascadeSpeech.style(for: "やった！").contains("明るく弾む"))
        XCTAssertEqual(ShannonGeminiCascadeSpeech.finalizeDelayMilliseconds(for: "そうだけど", turnComplete: false), 420)
        XCTAssertEqual(ShannonGeminiCascadeSpeech.finalizeDelayMilliseconds(for: "はい。", turnComplete: false), 80)
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

    func testPCMUsesFirstChannelFromInterleavedMicrophoneFrames() {
        let stereoSamples: [Float] = [-1, 0.75, 0, 0.75, 1, 0.75]
        let data = stereoSamples.withUnsafeBufferPointer {
            ShannonGeminiLivePCM.pcm16Mono16k(samples: $0, sampleRate: 48_000, stride: 2)
        }
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertEqual(values, [Int16.min + 1])
        let rms = stereoSamples.withUnsafeBufferPointer {
            ShannonGeminiLivePCM.rootMeanSquare(samples: $0, stride: 2)
        }
        XCTAssertEqual(rms, Float((2.0 / 3.0).squareRoot()), accuracy: 0.0001)
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
