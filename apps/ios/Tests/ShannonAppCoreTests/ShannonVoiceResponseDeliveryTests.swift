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
