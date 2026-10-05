import Foundation
import Testing
@testable import ShannonAppCore

@MainActor
struct ShannonVoiceResponseDeliveryTests {
    @Test func completeAnswerIsNotCarriedOverWhenAudioFailsOrIsInterrupted() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "最初の質問", text: "最初の質問", source: .speech)
        let batch = try #require(ledger.batch())
        var delivery = ShannonVoiceResponseDelivery()
        try delivery.complete(Self.answer, batch: batch, ledger: &ledger)
        delivery.scheduledAudio(seconds: 1)
        #expect(ledger.turns.isEmpty)
        #expect(delivery.failureMessage.contains("音声"))
        #expect(!delivery.failureMessage.contains("入力は保持"))
        ledger.append(rawText: "新しい質問", text: "新しい質問", source: .speech)
        #expect(ledger.batch()?.text == "新しい質問")
    }

    @Test func incompleteAnswerKeepsInputEvenAfterPartialAudio() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "依頼", text: "依頼", source: .typed)
        var delivery = ShannonVoiceResponseDelivery()
        delivery.scheduledAudio(seconds: 1)
        #expect(delivery.failureMessage.contains("途中で止まり"))
        #expect(delivery.failureMessage.contains("未完了の入力は保持"))
        ledger.append(rawText: "追加条件", text: "追加条件", source: .speech)
        #expect(ledger.batch()?.text == "依頼\n追加条件")
    }

    @Test func invalidCompletionCannotDiscardInput() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "質問", text: "質問", source: .speech)
        let batch = try #require(ledger.batch())
        var delivery = ShannonVoiceResponseDelivery()
        #expect(throws: ShannonAPIError.self) {
            try delivery.complete(.init(threadId: "thread", model: "test", reply: ""),
                batch: batch, ledger: &ledger)
        }
        #expect(ledger.turns.count == 1)
        #expect(delivery.response == nil)
        #expect(delivery.failureMessage.contains("返答を作れません"))
    }

    @Test func completionAcknowledgesOnlyFrozenPrefix() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "質問", text: "質問", source: .speech)
        let batch = try #require(ledger.batch())
        ledger.append(rawText: "追加", text: "追加", source: .speech)
        var delivery = ShannonVoiceResponseDelivery()
        try delivery.complete(Self.answer, batch: batch, ledger: &ledger)
        #expect(ledger.batch()?.text == "追加")
    }

    @Test func streamCompletionDoesNotWaitForEOFOrAcceptLateTransportFailure() async throws {
        let lines = AsyncThrowingStream<String, Error> { continuation in
            continuation.yield(#"{"type":"completed","response":{"threadId":"thread","model":"test","reply":"できました。"}}"#)
            continuation.finish(throwing: URLError(.networkConnectionLost))
        }
        let answer = try await ShannonVoiceStreamReader.read(lines: lines) { _, _ in }
        #expect(answer.reply == "できました。")
    }

    @Test func aReplyCutAtItsLengthLimitIsAFinishedReplyThatPlaysAndIsSaved() async throws {
        let lines = AsyncThrowingStream<String, Error> { continuation in
            continuation.yield(#"{"type":"plan"}"#)
            continuation.yield(#"{"type":"segment","text":"むかしむかし。"}"#)
            continuation.yield(#"{"type":"segment","text":"灯台がありました。"}"#)
            continuation.yield(#"{"type":"completed","response":{"threadId":"thread","model":"test","reply":"むかしむかし。灯台がありました。","truncated":true}}"#)
            continuation.finish()
        }
        var spoken: [String] = []
        let answer = try await ShannonVoiceStreamReader.read(lines: lines) { text, _ in spoken.append(text) }
        #expect(spoken == ["むかしむかし。", "灯台がありました。"])
        #expect(answer.truncated == true)
        // Completion acknowledges the input, so the reply is written to Talk and nothing is re-sent.
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "長いセリフを言って", text: "長いセリフを言って", source: .speech)
        let batch = try #require(ledger.batch())
        var delivery = ShannonVoiceResponseDelivery()
        try delivery.complete(answer, batch: batch, ledger: &ledger)
        #expect(ledger.turns.isEmpty)
        // A reply without the flag (a server before it) decodes as before.
        let plain = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self,
            from: Data(#"{"threadId":"thread","model":"test","reply":"はい。"}"#.utf8))
        #expect(plain.truncated == nil)
    }

    @Test func aFailureLetsHerVoiceAlreadyOnItsWayFinishUnlessPlaybackStalledOrContentWasWithheld() {
        let failure = ShannonAPIError.rejected(status: 502)
        #expect(ShannonVoiceResponseDelivery.queuedSpeech(afterFailureAt: "generation", error: failure) == .finishReceivedSentences)
        #expect(ShannonVoiceResponseDelivery.queuedSpeech(afterFailureAt: "synthesis_stream", error: failure) == .finishScheduledAudio)
        #expect(ShannonVoiceResponseDelivery.queuedSpeech(afterFailureAt: "playback", error: failure) == .discard)
        #expect(ShannonVoiceResponseDelivery.queuedSpeech(afterFailureAt: "generation", error: ShannonVoiceReplyWithheld()) == .discard)
        #expect(ShannonVoiceResponseDelivery.errorCategory(ShannonVoiceReplyWithheld()) == "content_filter")
    }

    @Test func aWithheldReplyIsNamedByTheStreamAndOtherErrorsStayAsBefore() async {
        let withheld = AsyncThrowingStream<String, Error> { continuation in
            continuation.yield(#"{"type":"segment","text":"途中まで。"}"#)
            continuation.yield(#"{"type":"error","status":502,"code":"content_filter"}"#)
            continuation.finish()
        }
        await #expect(throws: ShannonVoiceReplyWithheld.self) {
            try await ShannonVoiceStreamReader.read(lines: withheld) { _, _ in }
        }
        let failed = AsyncThrowingStream<String, Error> { continuation in
            continuation.yield(#"{"type":"error","status":502}"#)
            continuation.finish()
        }
        await #expect(throws: ShannonAPIError.rejected(status: 502)) {
            try await ShannonVoiceStreamReader.read(lines: failed) { _, _ in }
        }
    }

    @Test func whatSheSaidOfAnUnfinishedAnswerBecomesHerReplyAndTheInputIsNotAskedAgain() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "長い話をして", text: "長い話をして", source: .speech)
        let batch = try #require(ledger.batch())
        var delivery = ShannonVoiceResponseDelivery()
        // The waiting phrase, then three answer sentences; only two of them were played.
        delivery.spoken.queued("少し考えますね。", waitingPhrase: "少し考えますね。")
        delivery.spoken.queued("むかしむかし。", waitingPhrase: "少し考えますね。")
        delivery.spoken.queued("😊", waitingPhrase: "少し考えますね。")
        delivery.spoken.queued("灯台がありました。", waitingPhrase: "少し考えますね。")
        delivery.spoken.queued("まだ言っていない文。", waitingPhrase: "少し考えますね。")
        delivery.spoken.played("少し考えますね。")
        delivery.spoken.played("むかしむかし。")
        delivery.spoken.played("灯台がありました。")
        delivery.scheduledAudio(seconds: 3)
        let kept = delivery.keepSpokenPart(batch: batch, ledger: &ledger)
        #expect(kept == "むかしむかし。😊灯台がありました。…")
        #expect(ledger.turns.isEmpty)
        #expect(delivery.failureMessage.contains("話した部分までを会話に残し"))
    }

    @Test func aKeptPartCarriesTheFeelingOfTheAnswerNotOfTheWaitingPhrase() throws {
        var spoken = ShannonVoiceSpokenReply()
        spoken.queued("少し考えますね。", waitingPhrase: "少し考えますね。",
                      emotion: ShannonVoiceTurnEmotionDTO(primary: "caring", intensity: 0.6))
        #expect(spoken.emotion == nil)
        spoken.queued("むかしむかし。", waitingPhrase: "少し考えますね。",
                      emotion: ShannonVoiceTurnEmotionDTO(primary: "excited", intensity: 0.8))
        #expect(spoken.emotion == ShannonVoiceTurnEmotionDTO(primary: "excited", intensity: 0.8))
    }

    @Test func aKeptPartThatCouldNotBeWrittenIsNotCalledKept() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "長い話をして", text: "長い話をして", source: .speech)
        let batch = try #require(ledger.batch())
        var delivery = ShannonVoiceResponseDelivery()
        delivery.spoken.queued("むかしむかし。", waitingPhrase: nil)
        delivery.spoken.played("むかしむかし。")
        #expect(delivery.keepSpokenPart(batch: batch, ledger: &ledger) == "むかしむかし。…")
        delivery.keptPartNotSaved()
        #expect(delivery.failureMessage.contains("保存できませんでした"))
        #expect(!delivery.failureMessage.contains("残しています"))
    }

    @Test func aWithheldReplyDropsItsInputSoItIsNotSentAgain() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "質問", text: "質問", source: .speech)
        let batch = try #require(ledger.batch())
        ledger.append(rawText: "後から言ったこと", text: "後から言ったこと", source: .speech)
        var delivery = ShannonVoiceResponseDelivery()
        delivery.scheduledAudio(seconds: 2)
        delivery.withdraw(batch: batch, ledger: &ledger)
        #expect(ledger.batch()?.text == "後から言ったこと")
        #expect(delivery.failureMessage.contains("取り消され"))
        #expect(!delivery.failureMessage.contains("保持"))
    }

    @Test func nothingIsKeptWhenSheSaidOnlyTheWaitingPhrase() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "天気は？", text: "天気は？", source: .speech)
        let batch = try #require(ledger.batch())
        var delivery = ShannonVoiceResponseDelivery()
        delivery.spoken.queued("空模様を確かめますね。", waitingPhrase: "空模様を確かめますね。")
        delivery.spoken.played("空模様を確かめますね。")
        delivery.scheduledAudio(seconds: 1)
        #expect(delivery.keepSpokenPart(batch: batch, ledger: &ledger) == nil)
        #expect(ledger.turns.count == 1)
        #expect(delivery.failureMessage.contains("未完了の入力は保持"))
    }

    @Test func theWatchdogBoundsAStallNotTheLengthOfATalk() async throws {
        let drain = ShannonVoicePlaybackDrain()
        let tickets = (0..<6).map { _ in drain.schedule() }
        let wait = Task { @MainActor in try await drain.wait(timeout: .milliseconds(150)) }
        // Six buffers played 100 ms apart: 600 ms in all, never 150 ms without progress.
        for ticket in tickets {
            try await Task.sleep(for: .milliseconds(100))
            drain.played(ticket)
        }
        try await wait.value
    }

    @Test func playedActionsRunOnlyForAudioThatActuallyPlayed() async {
        let drain = ShannonVoicePlaybackDrain()
        var played: [String] = []
        var progress: [Bool] = []
        drain.onProgress = { progress.append($0) }
        let first = drain.schedule { played.append("first") }
        let second = drain.schedule()
        #expect(drain.isPlaying)
        drain.played(first)
        drain.played(first)
        drain.played(second)
        #expect(played == ["first"])
        #expect(progress == [true, false])
        #expect(!drain.isPlaying)
        // Discarded audio (a barge-in) is never remembered as said.
        let discarded = drain.schedule { played.append("discarded") }
        drain.cancel()
        drain.played(discarded)
        #expect(played == ["first"])
    }

    @Test func streamWithoutCompletionRetainsFailure() async {
        let lines = AsyncThrowingStream<String, Error> { continuation in
            continuation.yield(#"{"type":"segment","text":"最初の文。"}"#)
            continuation.finish()
        }
        await #expect(throws: ShannonAPIError.self) {
            try await ShannonVoiceStreamReader.read(lines: lines) { _, _ in }
        }
    }

    @Test func playbackWaitsForEveryActualPlayedCallback() async throws {
        let drain = ShannonVoicePlaybackDrain()
        let first = drain.schedule()
        let last = drain.schedule()
        var finished = false
        let wait = Task { @MainActor in try await drain.wait(); finished = true }
        await Task.yield()
        drain.played(first)
        await Task.yield()
        #expect(!finished)
        drain.played(last)
        try await wait.value
        #expect(finished)
    }

    @Test func stopCallbacksCannotCompleteNewPlayback() async throws {
        let drain = ShannonVoicePlaybackDrain()
        let obsolete = drain.schedule()
        drain.cancel()
        let current = drain.schedule()
        var finished = false
        let wait = Task { @MainActor in try await drain.wait(); finished = true }
        drain.played(obsolete)
        await Task.yield()
        #expect(!finished)
        drain.played(current)
        try await wait.value
    }

    @Test func cancelledPlaybackWaitNeverHangs() async {
        let drain = ShannonVoicePlaybackDrain()
        _ = drain.schedule()
        let wait = Task { @MainActor in try await drain.wait() }
        await Task.yield()
        wait.cancel()
        await #expect(throws: CancellationError.self) { try await wait.value }
    }

    @Test func stalledPlaybackHasBoundedRecovery() async {
        let drain = ShannonVoicePlaybackDrain()
        _ = drain.schedule()
        await #expect(throws: ShannonVoicePlaybackDrain.Failure.self) {
            try await drain.wait(timeout: .milliseconds(1))
        }
    }

    @Test func repeatedCorrectionsAndLateCallbacksNeverLeakCompletedInput() async throws {
        var ledger = ShannonPendingVoiceTurns()
        let drain = ShannonVoicePlaybackDrain()
        for index in 0..<1_000 {
            let request = "合成依頼\(index)"
            let correction = "合成訂正\(index)"
            ledger.append(rawText: request, text: request, source: .speech)
            let cancelled = try #require(ledger.batch())
            ledger.append(rawText: correction, text: correction, source: .typed)
            let replacement = try #require(ledger.batch())
            #expect(replacement.text == "\(request)\n\(correction)")
            var delivery = ShannonVoiceResponseDelivery()
            try delivery.complete(Self.answer, batch: replacement, ledger: &ledger)
            // A stale request completion cannot consume a later user turn.
            ledger.append(rawText: "次の話", text: "次の話", source: .speech)
            ledger.acknowledge(cancelled)
            #expect(ledger.batch()?.text == "次の話")
            let obsolete = drain.schedule()
            drain.cancel()
            let current = drain.schedule()
            var finished = false
            let wait = Task { @MainActor in
                try await drain.wait(timeout: .seconds(1))
                finished = true
            }
            await Task.yield()
            drain.played(obsolete)
            await Task.yield()
            #expect(!finished)
            drain.played(current)
            try await wait.value
            #expect(finished)
            ledger.acknowledge(try #require(ledger.batch()))
            #expect(ledger.turns.isEmpty)
        }
    }

    private static let answer = ShannonLiveVoiceDelegationResponseDTO(
        threadId: "thread", model: "test", reply: "できました。")
}
