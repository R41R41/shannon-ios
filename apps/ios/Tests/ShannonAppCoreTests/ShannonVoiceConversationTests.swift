import XCTest
@testable import ShannonAppCore

final class ShannonVoiceConversationTests: XCTestCase {
    func testRealtimeActivePhasesAllowTransientConnectionRecovery() {
        XCTAssertFalse(ShannonRealtimeVoicePhase.idle.keepsSessionActive)
        XCTAssertTrue(ShannonRealtimeVoicePhase.requestingPermission.keepsSessionActive)
        XCTAssertTrue(ShannonRealtimeVoicePhase.connecting.keepsSessionActive)
        XCTAssertTrue(ShannonRealtimeVoicePhase.listening.keepsSessionActive)
        XCTAssertTrue(ShannonRealtimeVoicePhase.thinking.keepsSessionActive)
        XCTAssertTrue(ShannonRealtimeVoicePhase.speaking.keepsSessionActive)
        XCTAssertFalse(ShannonRealtimeVoicePhase.failed.keepsSessionActive)
        XCTAssertEqual(ShannonRealtimeVoiceRecoveryPolicy.disconnectGracePeriod, .seconds(5))
    }

    func testRealtimeAudioInterruptionPolicyWaitsResumesOrFailsOnlyForActiveSessions() {
        XCTAssertEqual(
            ShannonRealtimeVoiceRecoveryPolicy.interruptionAction(for: .began, phase: .speaking),
            .wait
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceRecoveryPolicy.interruptionAction(
                for: .ended(shouldResume: true),
                phase: .connecting
            ),
            .resume
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceRecoveryPolicy.interruptionAction(
                for: .ended(shouldResume: false),
                phase: .listening
            ),
            .fail
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceRecoveryPolicy.interruptionAction(for: .began, phase: .idle),
            .ignore
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceRecoveryPolicy.interruptionAction(
                for: .ended(shouldResume: false),
                phase: .failed
            ),
            .ignore
        )
    }

    func testRealtimeTranscriptEventsAreVisibleAsDeltasAndPairInEitherCompletionOrder() throws {
        var state = ShannonRealtimeVoiceTranscriptState()
        let inputDelta = try XCTUnwrap(ShannonRealtimeVoiceEvent.decode(Data(
            #"{"type":"conversation.item.input_audio_transcription.delta","delta":"明日は"}"#.utf8
        )))
        XCTAssertNil(state.apply(inputDelta))
        XCTAssertEqual(state.userText, "明日は")

        XCTAssertNil(state.apply(.inputTranscriptDone("明日は散歩したい")))
        XCTAssertNil(state.apply(.outputTranscriptDelta("朝なら")))
        XCTAssertEqual(state.shannonText, "朝なら")
        XCTAssertEqual(
            state.apply(.outputTranscriptDone("朝なら涼しそう。"))?.user,
            "明日は散歩したい"
        )

        XCTAssertNil(state.apply(.speechStarted))
        XCTAssertEqual(state.userText, "")
        XCTAssertNil(state.apply(.outputTranscriptDone("いいね。")))
        let reversed = state.apply(.inputTranscriptDone("そうしよう"))
        XCTAssertEqual(reversed?.user, "そうしよう")
        XCTAssertEqual(reversed?.shannon, "いいね。")
    }

    func testRealtimeEventsDecodeSpeechResponseAndSafeErrors() {
        XCTAssertEqual(event(#"{"type":"input_audio_buffer.speech_started"}"#), .speechStarted)
        XCTAssertEqual(event(#"{"type":"input_audio_buffer.speech_stopped"}"#), .speechStopped)
        XCTAssertEqual(event(#"{"type":"response.created"}"#), .responseStarted)
        XCTAssertEqual(event(#"{"type":"response.done"}"#), .responseFinished(nil))
        XCTAssertEqual(
            event(#"{"type":"response.output_audio_transcript.delta","delta":"うん"}"#),
            .outputTranscriptDelta("うん")
        )
        XCTAssertEqual(
            event(#"{"type":"error","error":{"code":"session_expired","message":"secret"}}"#),
            .failed("session_expired")
        )
        XCTAssertEqual(
            event(#"{"type":"response.function_call_arguments.done","name":"consult_shannon_backend","call_id":"call_123","arguments":"{\"request\":\"浜松駅からの終電を調べて\"}"}"#),
            .realtimeFunctionCall(callID: "call_123", request: "浜松駅からの終電を調べて")
        )
    }

    func testLiveEventsDecodeTimelineTranscriptsDelegationAndUsage() {
        XCTAssertEqual(event(#"{"type":"session.started","session":{"id":"live_1"}}"#), .sessionReady)
        XCTAssertEqual(
            event(#"{"type":"session.input_transcript.delta","delta":"浜松の","start_ms":100,"end_ms":300}"#),
            .liveInputTranscriptDelta("浜松の", startMilliseconds: 100, endMilliseconds: 300)
        )
        XCTAssertEqual(
            event(#"{"type":"session.output_transcript.delta","delta":"調べるね","start_ms":500,"end_ms":800}"#),
            .liveOutputTranscriptDelta("調べるね", startMilliseconds: 500, endMilliseconds: 800)
        )
        XCTAssertEqual(
            event(#"{"type":"session.delegation.created","offset_ms":900,"delegation":{"id":"item_live_1","type":"delegation","target":"client"}}"#),
            .liveDelegationRequested(id: "item_live_1", offsetMilliseconds: 900)
        )
        XCTAssertEqual(
            event(#"{"type":"session.usage.updated","usage":{"seconds":12.5}}"#),
            .liveUsageUpdated(seconds: 12.5)
        )
        XCTAssertEqual(
            event(#"{"type":"session.closed","reason":"close_requested"}"#),
            .liveSessionClosed(reason: "close_requested")
        )
    }

    func testLiveTranscriptPairsOnSpeakerTurnAndFlushesTheLastTurn() throws {
        var state = ShannonRealtimeVoiceTranscriptState()
        XCTAssertNil(state.apply(.liveInputTranscriptDelta(
            "浜松の天気は？", startMilliseconds: 100, endMilliseconds: 900
        )))
        XCTAssertEqual(state.delegationTranscript, "浜松の天気は？")
        XCTAssertNil(state.apply(.liveOutputTranscriptDelta(
            "午後は雨かも。", startMilliseconds: 1_000, endMilliseconds: 1_800
        )))

        let first = try XCTUnwrap(state.apply(.liveInputTranscriptDelta(
            "傘は必要？", startMilliseconds: 2_100, endMilliseconds: 2_600
        )))
        XCTAssertEqual(first.user, "浜松の天気は？")
        XCTAssertEqual(first.shannon, "午後は雨かも。")
        XCTAssertEqual(state.userText, "傘は必要？")
        XCTAssertEqual(state.shannonText, "")

        XCTAssertNil(state.apply(.liveOutputTranscriptDelta(
            "折り畳み傘が安心。", startMilliseconds: 2_800, endMilliseconds: 3_500
        )))
        let last = try XCTUnwrap(state.flushPendingLiveTurn())
        XCTAssertEqual(last.user, "傘は必要？")
        XCTAssertEqual(last.shannon, "折り畳み傘が安心。")
    }

    func testTypedTextBeginsAVisibleTurnAndFlushesAnEarlierLiveTurn() throws {
        var state = ShannonRealtimeVoiceTranscriptState()
        XCTAssertNil(state.apply(.liveInputTranscriptDelta(
            "先の質問", startMilliseconds: 100, endMilliseconds: 500
        )))
        XCTAssertNil(state.apply(.liveOutputTranscriptDelta(
            "先の回答", startMilliseconds: 600, endMilliseconds: 1_000
        )))

        let completed = try XCTUnwrap(state.beginTypedUserTurn("  文字で続ける  "))
        XCTAssertEqual(completed.user, "先の質問")
        XCTAssertEqual(completed.shannon, "先の回答")
        XCTAssertEqual(state.userText, "文字で続ける")
        XCTAssertEqual(state.shannonText, "")
    }

    func testRealtimeTextTurnCreatesUserItemThenRequestsResponse() throws {
        let events = try ShannonLiveVoiceClientEvent.realtimeTextTurn(content: "  声を止めずに送る  ")
        XCTAssertEqual(events.count, 2)
        let item = try XCTUnwrap(JSONSerialization.jsonObject(with: events[0]) as? [String: Any])
        XCTAssertEqual(item["type"] as? String, "conversation.item.create")
        let message = try XCTUnwrap(item["item"] as? [String: Any])
        XCTAssertEqual(message["role"] as? String, "user")
        let content = try XCTUnwrap(message["content"] as? [[String: Any]])
        XCTAssertEqual(content.first?["type"] as? String, "input_text")
        XCTAssertEqual(content.first?["text"] as? String, "声を止めずに送る")

        let response = try XCTUnwrap(JSONSerialization.jsonObject(with: events[1]) as? [String: Any])
        XCTAssertEqual(response["type"] as? String, "response.create")
    }

    func testVoiceInputStateExposesAvailabilityAndActualRoute() {
        let state = ShannonVoiceInputState(
            preference: .builtIn,
            activeInputName: "iPhone Microphone",
            isBuiltInAvailable: true,
            isConnectedInputAvailable: false
        )
        XCTAssertEqual(state.activeInputLabel, "使用中: iPhone Microphone")
        XCTAssertTrue(state.canSelect(.automatic))
        XCTAssertTrue(state.canSelect(.builtIn))
        XCTAssertFalse(state.canSelect(.connected))
    }

    func testLiveCommentaryEventIsBoundedAndKeepsTheOpaqueDelegationID() throws {
        let data = try ShannonLiveVoiceClientEvent.commentary(
            delegationID: "item_opaque_123",
            content: String(repeating: "あ", count: 1_000)
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "session.commentary.append")
        XCTAssertEqual(json["delegation_id"] as? String, "item_opaque_123")
        XCTAssertEqual((json["content"] as? String)?.count, 800)
        XCTAssertTrue((json["event_id"] as? String)?.hasPrefix("shannon-result-") == true)
    }

    func testRealtimeFunctionResultAppendsOutputWithoutStartingAnUncoordinatedResponse() throws {
        let events = try ShannonLiveVoiceClientEvent.realtimeFunctionResult(
            callID: "call_123",
            content: "現在の検索結果です。"
        )
        XCTAssertEqual(events.count, 1)
        let output = try XCTUnwrap(JSONSerialization.jsonObject(with: events[0]) as? [String: Any])
        XCTAssertEqual(output["type"] as? String, "conversation.item.create")
        XCTAssertTrue((output["event_id"] as? String)?.hasPrefix("shannon-tool-") == true)
        XCTAssertFalse((output["event_id"] as? String)?.contains("UUID()") == true)
        let item = try XCTUnwrap(output["item"] as? [String: Any])
        XCTAssertEqual(item["type"] as? String, "function_call_output")
        XCTAssertEqual(item["call_id"] as? String, "call_123")
        XCTAssertEqual(item["output"] as? String, "現在の検索結果です。")
    }

    func testCameraObservationCommentaryHasAnExplicitNullDelegationID() throws {
        let data = try ShannonLiveVoiceClientEvent.commentary(
            delegationID: nil,
            content: "青い案内板が見えます。"
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "session.commentary.append")
        XCTAssertTrue(json["delegation_id"] is NSNull)
        XCTAssertEqual(json["content"] as? String, "青い案内板が見えます。")
    }

    func testRealtimeResponseUsageDecodesAndAccumulatesWithoutRawResponseContent() throws {
        let decoded = try XCTUnwrap(event(#"{"type":"response.done","response":{"usage":{"total_tokens":31,"input_tokens":20,"output_tokens":11,"input_token_details":{"cached_tokens":4,"audio_tokens":8},"output_token_details":{"audio_tokens":7}}}}"#))
        guard case .responseFinished(let sample) = decoded else {
            return XCTFail("Expected response usage")
        }
        XCTAssertEqual(
            sample,
            ShannonRealtimeVoiceUsage(
                totalTokens: 31,
                inputTokens: 20,
                outputTokens: 11,
                cachedInputTokens: 4,
                inputAudioTokens: 8,
                outputAudioTokens: 7
            )
        )

        var total = ShannonRealtimeVoiceUsage.zero
        total.append(try XCTUnwrap(sample))
        total.append(ShannonRealtimeVoiceUsage(totalTokens: 9, inputTokens: 5, outputTokens: 4))
        XCTAssertEqual(total.totalTokens, 40)
        XCTAssertEqual(total.inputTokens, 25)
        XCTAssertEqual(total.outputTokens, 15)
    }

    func testRealtimeSessionBudgetClampsAndFormatsRemainingTime() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(
            ShannonRealtimeVoiceBudgetPolicy.remainingLabel(startedAt: start, now: start),
            "残り 10:00"
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceBudgetPolicy.remainingLabel(
                startedAt: start,
                now: start.addingTimeInterval(125)
            ),
            "残り 07:55"
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceBudgetPolicy.remainingSeconds(
                startedAt: start,
                now: start.addingTimeInterval(999)
            ),
            0
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceBudgetPolicy.dailyRemainingLabel(seconds: 3_000),
            "本日あと最大 50分"
        )
    }

    func testRealtimeFailurePresentationExplainsDailyAllowanceAndKeepsTextAvailable() {
        XCTAssertEqual(
            ShannonRealtimeVoiceFailurePresentation.startMessage(
                for: ShannonAPIError.realtimeVoiceRejected(
                    status: 429,
                    code: "VOICE_REALTIME_DAILY_ALLOWANCE_EXHAUSTED"
                )
            ),
            "今日はライブ音声を十分使いました。テキスト会話は引き続き使えます。"
        )
        XCTAssertEqual(
            ShannonRealtimeVoiceFailurePresentation.startMessage(
                for: ShannonAPIError.realtimeVoiceRejected(status: 429, code: "RATE_LIMITED")
            ),
            "短時間に接続が続きました。少し待ってからもう一度お試しください。"
        )
    }

    func testRealtimeOfferDiagnosticsDescribeStructureWithoutKeepingSDP() {
        let sdp = """
        v=0\r
        m=audio 9 UDP/TLS/RTP/SAVPF 111\r
        a=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r
        a=candidate:2 1 UDP 1 192.0.2.2 5001 typ host\r
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
        """

        let diagnostics = ShannonRealtimeOfferDiagnostics(sdp: sdp)

        XCTAssertEqual(diagnostics.audioSectionCount, 1)
        XCTAssertEqual(diagnostics.dataSectionCount, 1)
        XCTAssertEqual(diagnostics.candidateCount, 2)
        XCTAssertEqual(diagnostics.metadata["ice_gathering"], "complete")
        XCTAssertNil(diagnostics.metadata["sdp"])
    }

    func testPrimaryActionFollowsHalfDuplexVoiceState() {
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .idle), .start)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .requestingPermission), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .listening), .send)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .ready), .send)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .transcribing), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .thinking), .none)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .speaking), .stopSpeaking)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .denied), .start)
        XCTAssertEqual(ShannonVoicePrimaryAction.action(for: .failed), .start)
    }

    func testEveryVoicePhaseHasUserFacingLabelAndSymbol() {
        let phases: [ShannonVoicePhase] = [
            .idle, .requestingPermission, .listening, .ready, .transcribing, .thinking, .speaking, .denied, .failed,
        ]
        for phase in phases {
            XCTAssertFalse(phase.japaneseLabel.isEmpty)
            XCTAssertFalse(phase.symbolName.isEmpty)
        }
    }

    func testRecordingPolicyRejectsEmptyShortOversizedAndOverlongAudio() {
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 0.1, byteCount: 1_024))
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 1, byteCount: 0))
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 1, byteCount: 5 * 1_024 * 1_024 + 1))
        XCTAssertFalse(ShannonVoiceRecordingPolicy.isUsable(duration: 61, byteCount: 1_024))
        XCTAssertTrue(ShannonVoiceRecordingPolicy.isUsable(duration: 1, byteCount: 1_024))
    }

    func testUsageDescriptionRequiresNonEmptyText() {
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent(nil))
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent(42))
        XCTAssertFalse(ShannonVoiceUsageDescriptionPolicy.isPresent("  \n"))
        XCTAssertTrue(ShannonVoiceUsageDescriptionPolicy.isPresent("音声認識に使います"))
    }

    func testVoiceDiagnosticsPersistBreadcrumbsWithoutSensitiveContent() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShannonVoiceDiagnosticsTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let diagnostics = ShannonVoiceDiagnostics(
            fileURL: directory.appendingPathComponent("voice.jsonl")
        )

        diagnostics.record(
            "capture.tap.before",
            sessionID: "session-1",
            metadata: [
                "sample_rate": "48000",
                "transcript": "これは保存してはいけない",
                "token_value": "secret-value",
            ]
        )

        let report = diagnostics.report()
        XCTAssertTrue(report.contains("capture.tap.before"))
        XCTAssertTrue(report.contains("sample_rate=48000"))
        XCTAssertTrue(report.contains("transcript=<redacted>"))
        XCTAssertTrue(report.contains("token_value=<redacted>"))
        XCTAssertFalse(report.contains("これは保存してはいけない"))
        XCTAssertFalse(report.contains("secret-value"))
    }

    private func event(_ json: String) -> ShannonRealtimeVoiceEvent? {
        ShannonRealtimeVoiceEvent.decode(Data(json.utf8))
    }
}
