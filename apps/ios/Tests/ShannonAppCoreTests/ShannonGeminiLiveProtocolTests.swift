import XCTest
@testable import ShannonAppCore

final class ShannonGeminiLiveProtocolTests: XCTestCase {
    func testWebSocketRequestAuthorizesWithTheEphemeralSecretOnly() throws {
        let request = try ShannonOpenAITranscriptionProtocol.webSocketRequest(token: "ek_synthetic_secret")
        XCTAssertEqual(request.url?.absoluteString, "wss://api.openai.com/v1/realtime?intent=transcription")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ek_synthetic_secret")
        XCTAssertNil(request.url?.query?.range(of: "ek_"))
        // A permanent key or an old server's Gemini token must never be sent to OpenAI.
        XCTAssertThrowsError(try ShannonOpenAITranscriptionProtocol.webSocketRequest(token: "sk-permanent"))
        XCTAssertThrowsError(try ShannonOpenAITranscriptionProtocol.webSocketRequest(token: "auth_tokens/x"))
        XCTAssertThrowsError(try ShannonOpenAITranscriptionProtocol.webSocketRequest(token: ""))
    }

    func testAudioMessageAppendsBase64PCMToTheInputBuffer() throws {
        let pcm = Data([0x01, 0x02, 0x03, 0x04])
        let data = try ShannonOpenAITranscriptionProtocol.audioMessage(pcm)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(root["type"] as? String, "input_audio_buffer.append")
        XCTAssertEqual(root["audio"] as? String, pcm.base64EncodedString())
        XCTAssertEqual(root.count, 2)
    }

    func testServerEventsDecodeReadinessSpeechBoundariesAndFinalTranscript() throws {
        func events(_ message: [String: Any]) throws -> [ShannonTranscriptionEvent] {
            try ShannonOpenAITranscriptionProtocol.events(from: JSONSerialization.data(withJSONObject: message))
        }
        XCTAssertEqual(try events(["type": "session.created", "session": ["type": "transcription"]]), [.sessionReady])
        XCTAssertEqual(try events(["type": "input_audio_buffer.speech_started"]), [.speechStarted()])
        XCTAssertEqual(try events(["type": "input_audio_buffer.speech_started", "item_id": "item_1"]), [.speechStarted(itemID: "item_1")])
        XCTAssertEqual(try events(["type": "input_audio_buffer.speech_stopped"]), [.speechStopped()])
        XCTAssertEqual(try events(["type": "input_audio_buffer.speech_stopped", "item_id": "item_1"]), [.speechStopped(itemID: "item_1")])
        XCTAssertEqual(try events([
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": " 明日は晴れるかな。\n",
        ]), [.inputTranscript("明日は晴れるかな。")])
        // Completions of different turns can arrive out of order: the id travels with the words.
        XCTAssertEqual(try events([
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item_2", "transcript": "はじめまして",
        ]), [.inputTranscript("はじめまして", itemID: "item_2")])
    }

    func testServerEventsIgnoreLiveDeltasEmptyTranscriptsAndUnrelatedMessages() throws {
        func events(_ message: [String: Any]) throws -> [ShannonTranscriptionEvent] {
            try ShannonOpenAITranscriptionProtocol.events(from: JSONSerialization.data(withJSONObject: message))
        }
        // Shannon shows no live caption, so a transcript delta never reaches the session.
        XCTAssertEqual(try events(["type": "conversation.item.input_audio_transcription.delta", "delta": "明"]), [])
        XCTAssertEqual(try events(["type": "conversation.item.input_audio_transcription.completed", "transcript": "  "]), [])
        XCTAssertEqual(try events(["type": "input_audio_buffer.committed"]), [])
        XCTAssertEqual(try events(["type": "session.updated"]), [])
        // A non-fatal error must not drop the call; only the socket closing does.
        XCTAssertEqual(try events(["type": "error", "error": ["code": "input_audio_buffer_commit_empty"]]), [])
        XCTAssertEqual(try events(["noType": true]), [])
        XCTAssertEqual(try ShannonOpenAITranscriptionProtocol.events(from: Data("[]".utf8)), [])
    }

    func testSessionDTORequiresOpenAIProviderAndAcceptsOnlyTranscriptionModels() throws {
        let json = """
        {"token":"ek_x","model":"gpt-4o-mini-transcribe","voice":"Aoede","threadId":"t",\
        "instructions":"i","expiresAt":"2026-10-01T00:00:00.000Z",\
        "inputUsdPerMinute":0.003,"outputUsdPerMinute":0.018,"transcriptionProvider":"openai"}
        """
        let dto = try JSONDecoder().decode(ShannonGeminiLiveSessionDTO.self, from: Data(json.utf8))
        XCTAssertEqual(dto.transcriptionProvider, "openai")
        XCTAssertTrue(ShannonOpenAITranscriptionProtocol.acceptedModels.contains(dto.model))
        XCTAssertFalse(ShannonOpenAITranscriptionProtocol.acceptedModels.contains("whisper-1"))
        XCTAssertFalse(ShannonOpenAITranscriptionProtocol.acceptedModels.contains("gemini-3.5-transcribe-live"))
        // An old server omits the field; the client treats that as unusable.
        let legacy = json.replacingOccurrences(of: ",\"transcriptionProvider\":\"openai\"", with: "")
        XCTAssertNil(try JSONDecoder().decode(ShannonGeminiLiveSessionDTO.self, from: Data(legacy.utf8)).transcriptionProvider)
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

    func testElevenActingTagsFollowTheSameVoicePlan() {
        let bright = ShannonVoicePlanDTO(
            shouldRespond: true, conversationClass: .direct,
            affect: .bright, delivery: .conversational
        )
        let playful = ShannonVoicePlanDTO(
            shouldRespond: true, conversationClass: .direct,
            affect: .playful, delivery: .quick
        )
        XCTAssertEqual(
            ShannonElevenCascadeSpeech.style(for: "おかえり", plan: bright),
            "[anime character] [cheerfully] [energetically]"
        )
        XCTAssertEqual(
            ShannonElevenCascadeSpeech.style(for: "ふふ、任せて", plan: playful),
            "[anime character] [playfully] [energetically]"
        )
        let caring = ShannonVoicePlanDTO(
            shouldRespond: true, conversationClass: .direct,
            affect: .caring, delivery: .gentle
        )
        XCTAssertEqual(
            ShannonElevenCascadeSpeech.style(for: "大丈夫？", plan: caring),
            "[anime character] [reassuringly] [calmly]"
        )
        XCTAssertEqual(
            ShannonElevenCascadeSpeech.style(for: "今日はどうしたの？", plan: nil),
            "[anime character] [playfully] [energetically]"
        )
        let smug = ShannonVoicePlanDTO(
            shouldRespond: true, conversationClass: .direct,
            affect: .smug, delivery: .quick
        )
        XCTAssertEqual(
            ShannonElevenCascadeSpeech.style(for: "やっぱりボクが正しかったです", plan: smug),
            "[anime character] [smugly] [energetically]"
        )
        let tender = ShannonVoicePlanDTO(
            shouldRespond: true, conversationClass: .direct,
            affect: .tender, delivery: .gentle
        )
        XCTAssertEqual(
            ShannonElevenCascadeSpeech.style(for: "ボクに任せてください", plan: tender),
            "[anime character] [cheerfully] [energetically]"
        )
        XCTAssertEqual(
            ShannonElevenCascadeSpeech.style(for: "そばにいますよ", plan: tender),
            "[anime character] [reassuringly] [calmly]"
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

    func testPCMResamplesToTwentyFourKilohertzAndClamps() {
        let samples: [Float] = [-2, -1, 0, 1, 2, 0]
        let data = samples.withUnsafeBufferPointer {
            ShannonGeminiLivePCM.pcm16Mono(samples: $0, sampleRate: 48_000)
        }
        XCTAssertEqual(data.count, 6)
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertEqual(values, [Int16.min + 1, 0, Int16.max])
    }

    func testPCMKeepsTheRequestedOutputRate() {
        let samples = [Float](repeating: 0.5, count: 480)
        let sixteen = samples.withUnsafeBufferPointer {
            ShannonGeminiLivePCM.pcm16Mono(samples: $0, sampleRate: 48_000, outputSampleRate: 16_000)
        }
        let twentyFour = samples.withUnsafeBufferPointer {
            ShannonGeminiLivePCM.pcm16Mono(samples: $0, sampleRate: 48_000)
        }
        XCTAssertEqual(sixteen.count, 160 * MemoryLayout<Int16>.size)
        XCTAssertEqual(twentyFour.count, 240 * MemoryLayout<Int16>.size)
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
            ShannonGeminiLivePCM.pcm16Mono(samples: $0, sampleRate: 48_000, stride: 2)
        }
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertEqual(values, [Int16.min + 1])
        let rms = stereoSamples.withUnsafeBufferPointer {
            ShannonGeminiLivePCM.rootMeanSquare(samples: $0, stride: 2)
        }
        XCTAssertEqual(rms, Float((2.0 / 3.0).squareRoot()), accuracy: 0.0001)
    }

    func testAudioChunkerEmitsHundredMillisecondChunks() throws {
        let chunker = ShannonGeminiLiveAudioChunker()
        XCTAssertTrue(chunker.append(Data(repeating: 1, count: 1_200)).isEmpty)

        let chunks = chunker.append(Data(repeating: 2, count: 8_400))
        XCTAssertEqual(chunks.map(\.count), [4_800, 4_800])
        let firstChunk = try XCTUnwrap(chunks.first)
        XCTAssertEqual(firstChunk.prefix(1_200), Data(repeating: 1, count: 1_200))

        chunker.reset()
        XCTAssertTrue(chunker.append(Data(repeating: 3, count: 4_799)).isEmpty)
        XCTAssertEqual(chunker.append(Data(repeating: 4, count: 1)).first?.count, 4_800)
    }
}
