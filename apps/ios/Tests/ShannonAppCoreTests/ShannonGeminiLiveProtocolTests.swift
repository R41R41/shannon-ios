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
        XCTAssertEqual(
            transcription["customVocabulary"] as? [String],
            [
                "シャノン", "ライ",
                "Aether", "エーテル",
                "Voyager", "ボイジャー",
                "Syzygy", "Jev", "Minebot", "Codex", "SwiftUI", "TestFlight",
            ]
        )
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
        let routed = ShannonVoicePlanDTO(
            shouldRespond: true,
            conversationClass: .skillSimple,
            affect: .caring,
            delivery: .gentle
        )
        let routedStyle = ShannonGeminiCascadeSpeech.style(for: "大丈夫？", plan: routed)
        XCTAssertTrue(routedStyle.contains("近く温かな声"))
        XCTAssertTrue(routedStyle.contains("少しゆっくり"))
        let bashful = ShannonVoicePlanDTO(
            shouldRespond: true,
            conversationClass: .direct,
            affect: .bashful,
            affectIntensity: 0.7,
            delivery: .conversational
        )
        XCTAssertTrue(
            ShannonGeminiCascadeSpeech.style(for: "そ、そんなこと言われると照れます。", plan: bashful)
                .contains("嬉しさの奥に照れ")
        )
    }

    func testDelegationResponseDecodesVisibleAgentTaskProposal() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "threadId": "thread-work",
            "model": "test-model",
            "reply": "作業案を出しました。",
            "uiBlocks": [[
                "type": "agent_task_proposal",
                "proposalId": "8EA464F4-969D-4E93-81C9-1810A209BC5A",
                "title": "Minebot音声対応",
                "goal": "Minebotへ音声会話を実装する",
            ]],
        ])
        let response = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self, from: data)
        XCTAssertEqual(response.uiBlocks?.first?.type, "agent_task_proposal")
        XCTAssertEqual(response.uiBlocks?.first?.title, "Minebot音声対応")
    }

    func testTurnAssemblerMergesCumulativeAndOverlappingFinalSegments() throws {
        var assembler = ShannonVoiceTurnAssembler()
        assembler.appendFinal("明日は晴れ")
        assembler.appendFinal("晴れです。")

        let envelope = try XCTUnwrap(assembler.finish())
        XCTAssertEqual(envelope.rawText, "明日は晴れです。")
        XCTAssertEqual(envelope.segments.map(\.text), ["明日は晴れ", "晴れです。"])
        XCTAssertTrue(envelope.alternatives.isEmpty)
        XCTAssertTrue(envelope.confidenceSpans.isEmpty)
    }

    func testTurnAssemblerNormalizesRegisteredVocabularyWithoutChangingRawText() throws {
        var assembler = ShannonVoiceTurnAssembler()
        assembler.appendFinal("エーテルとボイジャーをジェブでつないで")

        let envelope = try XCTUnwrap(assembler.finish())
        XCTAssertEqual(envelope.rawText, "エーテルとボイジャーをジェブでつないで")
        XCTAssertEqual(envelope.normalizedText, "AetherとVoyagerをJevでつないで")
    }

    func testTurnAssemblerKeepsInterimOutOfFinalProvenance() throws {
        let start = Date(timeIntervalSince1970: 100)
        var assembler = ShannonVoiceTurnAssembler()
        XCTAssertEqual(assembler.preview(interim: "シャノン、明日", receivedAt: start), "シャノン、明日")
        assembler.appendFinal("シャノン、明日は？", receivedAt: start.addingTimeInterval(0.2))

        let envelope = try XCTUnwrap(assembler.finish(endedAt: start.addingTimeInterval(0.3)))
        XCTAssertEqual(envelope.addressee, "shannon")
        XCTAssertEqual(envelope.segments.count, 1)
        XCTAssertEqual(envelope.startedAt, start)
    }

    func testTurnAssemblerLinksExplicitCorrectionToPreviousTurn() throws {
        var assembler = ShannonVoiceTurnAssembler()
        assembler.appendFinal("明日の予定を見て")
        let original = try XCTUnwrap(assembler.finish())
        assembler.appendFinal("違う、今日の予定を見て")
        let correction = try XCTUnwrap(assembler.finish())

        XCTAssertEqual(correction.correctionOf, original.id)
    }

    func testTurnAssemblerAdaptsFinalizationDelayToUtteranceShape() {
        var assembler = ShannonVoiceTurnAssembler()
        assembler.appendFinal("そうだけど")
        XCTAssertEqual(assembler.finalizationDelayMilliseconds(turnComplete: false), 420)
        XCTAssertEqual(assembler.finalizationDelayMilliseconds(turnComplete: true), 0)

        _ = assembler.finish()
        assembler.appendFinal("はい。")
        XCTAssertEqual(assembler.finalizationDelayMilliseconds(turnComplete: false), 80)
    }

    func testSpokenTextKeepsDisplayWordingButUsesNaturalPronunciations() {
        XCTAssertEqual(
            ShannonGeminiCascadeSpeech.spokenText(
                for: "AetherとVoyager、確認しますね！੧(❛□❛✿)"
            ),
            "エーテルとボイジャー、確認しますね！"
        )
        XCTAssertEqual(
            ShannonGeminiCascadeSpeech.spokenText(for: "さすがボクです笑"),
            "さすがボクですふふっ"
        )
    }

    func testLatencyMeasurementsKeepDecisionTextAndTTSStagesSeparate() {
        let plan = ShannonVoicePlanDTO(
            shouldRespond: true,
            conversationClass: .skillSimple,
            latencyClass: .underTenSeconds,
            affect: .serious,
            affectIntensity: 0.6,
            delivery: .focused,
            decisionLatencyMilliseconds: 84
        )
        var measurements = ShannonVoiceLatencyMeasurements()
        measurements.startResponse(now: 10)
        measurements.recordFirstText(plan: plan, now: 10.25)
        measurements.recordFirstTTSByte(requestStartedAt: 10.25, now: 10.5)
        measurements.recordFirstAudio(now: 10.8)

        XCTAssertEqual(measurements.decisionMilliseconds, 84)
        XCTAssertEqual(measurements.firstTextMilliseconds, 250)
        XCTAssertEqual(measurements.firstTTSByteMilliseconds, 250)
        XCTAssertEqual(measurements.firstAudioMilliseconds, 800)
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
