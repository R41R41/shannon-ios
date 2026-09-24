import XCTest
@testable import ShannonAppCore

final class ShannonRealtimeTurnCoordinatorTests: XCTestCase {
    func testToolPrefaceAndFinalAnswerPersistTogetherOnlyAfterPlayback() throws {
        var state = ShannonRealtimeTurnCoordinator()
        _ = state.apply(.init(kind: .speechStarted, itemID: "u1"))
        _ = state.apply(.init(kind: .inputDone, itemID: "u1", text: "終電を調べて"))
        _ = state.apply(.init(kind: .speechStopped, itemID: "u1"))
        _ = state.apply(.init(kind: .responseStarted, responseID: "r1"))
        XCTAssertNil(state.apply(.init(kind: .outputDone, itemID: "a1", responseID: "r1", text: "調べるね。")))
        let epoch = try XCTUnwrap(state.registerCall("c1", responseID: "r1"))
        XCTAssertTrue(state.finishCall("c1", epoch: epoch))
        XCTAssertFalse(state.takeResponseRequest()) // r1 is still active
        XCTAssertNil(state.apply(.init(kind: .responseFinished, responseID: "r1", status: "completed", hasTools: true)))
        XCTAssertTrue(state.takeResponseRequest())
        XCTAssertFalse(state.takeResponseRequest())
        _ = state.apply(.init(kind: .responseStarted, responseID: "r2"))
        _ = state.apply(.init(kind: .outputDone, itemID: "a2", responseID: "r2", text: "確認した結果はこちら。"))
        XCTAssertNil(state.apply(.init(kind: .responseFinished, responseID: "r2", status: "completed")))
        let completed = try XCTUnwrap(state.apply(.init(kind: .playbackStopped, responseID: "r2")))
        XCTAssertEqual(completed.user, "終電を調べて")
        XCTAssertEqual(completed.shannon, "調べるね。\n確認した結果はこちら。")
        XCTAssertNil(state.apply(.init(kind: .playbackStopped, responseID: "r2")))
    }

    func testBargeInInvalidatesOldToolAndDoesNotResumeIt() throws {
        var state = ShannonRealtimeTurnCoordinator()
        state.beginUserTurn(itemID: "u1", text: "浜松へ")
        _ = state.apply(.init(kind: .responseStarted, responseID: "r1"))
        let oldEpoch = try XCTUnwrap(state.registerCall("call", responseID: "r1"))
        _ = state.apply(.init(kind: .speechStarted, itemID: "u2"))
        XCTAssertFalse(state.finishCall("call", epoch: oldEpoch))
        XCTAssertNil(state.registerCall("call", responseID: "r1"))
        XCTAssertNil(state.registerCall("late-call", responseID: "r1"))
        XCTAssertNil(state.apply(.init(kind: .outputDone, itemID: "old", responseID: "r1", text: "古い回答")))
        XCTAssertFalse(state.takeResponseRequest())
        XCTAssertEqual(state.shannonText, "")
    }

    func testAllParallelCallsMustFinishBeforeOneFollowup() throws {
        var state = ShannonRealtimeTurnCoordinator()
        state.beginUserTurn(itemID: "u", text: "検索して")
        let epoch = try XCTUnwrap(state.registerCall("a"))
        XCTAssertEqual(state.registerCall("b"), epoch)
        XCTAssertTrue(state.finishCall("a", epoch: epoch))
        XCTAssertFalse(state.takeResponseRequest())
        XCTAssertTrue(state.finishCall("b", epoch: epoch))
        XCTAssertTrue(state.takeResponseRequest())
        XCTAssertFalse(state.takeResponseRequest())
        XCTAssertNil(state.registerCall("a"))
    }

    func testCancelledOrTruncatedAudioIsNeverSavedAsHeard() {
        var state = ShannonRealtimeTurnCoordinator()
        state.beginUserTurn(itemID: "u", text: "教えて")
        _ = state.apply(.init(kind: .responseStarted, responseID: "r"))
        _ = state.apply(.init(kind: .outputDone, itemID: "a", responseID: "r", text: "まだ聞いていない回答"))
        _ = state.apply(.init(kind: .truncated, itemID: "a"))
        _ = state.apply(.init(kind: .responseFinished, responseID: "r", status: "cancelled"))
        XCTAssertNil(state.apply(.init(kind: .playbackStopped, responseID: "r")))
    }

    func testLateInputTranscriptCanCompleteAnAlreadyPlayedAnswer() throws {
        var state = ShannonRealtimeTurnCoordinator()
        _ = state.apply(.init(kind: .speechStarted, itemID: "u"))
        _ = state.apply(.init(kind: .responseStarted, responseID: "r"))
        _ = state.apply(.init(kind: .outputDone, itemID: "a", responseID: "r", text: "そうだね"))
        _ = state.apply(.init(kind: .responseFinished, responseID: "r", status: "completed"))
        XCTAssertNil(state.apply(.init(kind: .playbackStopped, responseID: "r")))
        XCTAssertEqual(state.apply(.init(kind: .inputDone, itemID: "u", text: "いいね"))?.shannon, "そうだね")
    }

    func testDecoderRetainsProviderCorrelationIDs() throws {
        let data = Data(#"{"type":"response.output_audio_transcript.done","item_id":"a","response_id":"r","transcript":"こんにちは"}"#.utf8)
        guard case .correlated(let packet) = ShannonRealtimeVoiceEvent.decode(data) else { return XCTFail("IDs were lost") }
        XCTAssertEqual(packet.itemID, "a")
        XCTAssertEqual(packet.responseID, "r")
    }

    func testTypedInterruptionWaitsForOldResponseToStopBeforeRequestingAnother() {
        var state = ShannonRealtimeTurnCoordinator()
        state.beginUserTurn(itemID: "old", text: "最初の質問")
        _ = state.apply(.init(kind: .responseStarted, responseID: "r"))
        state.beginUserTurn(itemID: "new", text: "訂正")
        state.requestResponse()
        XCTAssertFalse(state.takeResponseRequest())
        _ = state.apply(.init(kind: .responseFinished, responseID: "r", status: "cancelled"))
        XCTAssertTrue(state.takeResponseRequest())
        XCTAssertFalse(state.belongsToCurrentTurn(responseID: "r"))
    }

    func testEmbodimentShowsRealToolWorkAndImmediatelyReturnsToListeningOnInterruption() {
        let working = ShannonVoiceEmbodimentFrame(phase: .thinking, pendingTools: 1, expression: .calm)
        XCTAssertEqual(working.activity, .working)
        XCTAssertEqual(working.attention, .tool)
        XCTAssertEqual(working.expression, .thinking)
        let interrupted = ShannonVoiceEmbodimentFrame(phase: .listening, pendingTools: 1, expression: .calm)
        XCTAssertEqual(interrupted.attention, .user)
        XCTAssertEqual(interrupted.activity, .listening)
    }
}
