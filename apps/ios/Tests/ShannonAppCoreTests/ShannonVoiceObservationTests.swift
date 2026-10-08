import Foundation
import Testing
@testable import ShannonAppCore

@MainActor
private final class ObservationAudience { var alone = true }

@MainActor
struct ShannonVoiceObservationTests {
    @Test func queueIsBoundedAndSendsSixteenAtATime() async {
        var batches: [[ShannonClientObserverEvent]] = []
        var dropped: [Int] = []
        let observer = ShannonVoiceObservation(automaticFlush: false, allowed: { true }, send: { batches.append($0); dropped.append($1); return true })
        let run = UUID()
        for _ in 0..<100 { observer.enqueue(.init(runId: run, spanId: UUID(), node: "pcm", kind: "span.completed")) }
        #expect(observer.queuedCount == 64)
        await observer.flush()
        #expect(batches.count == 1)
        #expect(batches[0].count == 16)
        #expect(observer.queuedCount == 48)
        #expect(dropped == [36])
        await observer.flush()
        #expect(dropped == [36, 0])
    }

    @Test func audienceChangeDiscardsQueuedEvents() async {
        let audience = ObservationAudience()
        var sends = 0
        let observer = ShannonVoiceObservation(automaticFlush: false, allowed: { audience.alone }, send: { _, _ in sends += 1; return true })
        observer.enqueue(.init(runId: UUID(), spanId: UUID(), node: "join", kind: "span.completed"))
        audience.alone = false
        await observer.flush()
        #expect(observer.queuedCount == 0)
        observer.enqueue(.init(runId: UUID(), spanId: UUID(), node: "join", kind: "span.completed"))
        #expect(observer.queuedCount == 0)
        #expect(sends == 0)
    }

    @Test func failedSendsKeepOnlyLossCountsAndNeverReplayEventPayloads() async {
        var attempts: [(ids: [UUID], dropped: Int)] = []
        let observer = ShannonVoiceObservation(automaticFlush: false, allowed: { true }, send: { batch, dropped in
            attempts.append((batch.map(\.spanId), dropped))
            return attempts.count > 2
        })
        let lost = UUID(), next = UUID(), run = UUID()
        observer.enqueue(.init(runId: run, spanId: lost, node: "play", kind: "span.completed"))
        await observer.flush()
        #expect(observer.queuedCount == 0)
        await observer.flush() // A loss-only attempt also fails: the count must survive.
        observer.enqueue(.init(runId: run, spanId: next, node: "pcm", kind: "span.completed"))
        await observer.flush()
        await observer.flush()
        #expect(attempts.map(\.ids) == [[lost], [], [next]])
        #expect(attempts.map(\.dropped) == [0, 1, 1])
    }

    @Test func acceptedLossOnlyReportClearsThePendingCount() async {
        var attempts: [(count: Int, dropped: Int)] = []
        let observer = ShannonVoiceObservation(automaticFlush: false, allowed: { true }, send: { batch, dropped in
            attempts.append((batch.count, dropped))
            return attempts.count > 1
        })
        observer.enqueue(.init(runId: UUID(), spanId: UUID(), node: "stt", kind: "span.completed"))
        await observer.flush()
        await observer.flush()
        await observer.flush()
        #expect(attempts.map(\.count) == [1, 0])
        #expect(attempts.map(\.dropped) == [0, 1])
    }

    @Test func transcriptAndJoinUseExplicitCaptureAndUtteranceIDsWithoutText() async throws {
        var events: [ShannonClientObserverEvent] = []
        let observer = ShannonVoiceObservation(automaticFlush: false, allowed: { true }, send: { batch, _ in events += batch; return true })
        let capture = UUID(), utterance = UUID()
        observer.beginCapture(id: capture, model: "gpt-4o-mini-transcribe")
        observer.pcmSent(byteCount: 4_800)
        _ = observer.transcription(.speechStarted(itemID: "item-1"))
        let recognized = observer.transcription(.inputTranscript("PRIVATE_TRANSCRIPT_SENTINEL", itemID: "item-1"))
        observer.acceptedTranscript(recognized)
        observer.joined(id: utterance, characterCount: 12, segmentCount: 1)
        observer.delegating(id: utterance, utteranceIDs: [utterance])
        observer.endCapture()
        while observer.queuedCount > 0 { await observer.flush() }
        let join = try #require(events.first { $0.node == "join" && $0.kind == "span.completed" })
        #expect(join.runId == utterance)
        #expect(join.parentSpanId == recognized)
        #expect(join.input?["captureRunId"] == .text(capture.uuidString))
        #expect(events.contains { $0.fromNode == "stt" && $0.toNode == "join" && $0.sourceSpanId == recognized })
        #expect(events.contains { $0.node == "pcm" && $0.output?["byteCount"] == .count(4_800) })
        let wire = String(decoding: try JSONEncoder().encode(events), as: UTF8.self)
        #expect(!wire.contains("PRIVATE_TRANSCRIPT_SENTINEL"))
        #expect(!wire.contains("base64"))
    }

    @Test func playbackCompletesOnlyAfterEveryScheduledByteIsReportedPlayed() {
        var events: [ShannonClientObserverEvent] = []
        let playback = ShannonObservedPlayback(runID: UUID(), model: "fixture", emit: { events.append($0) })
        playback.scheduled(4)
        playback.scheduled(6)
        playback.finishScheduling()
        playback.played(4)
        #expect(events.count == 1)
        playback.played(6)
        #expect(events.last?.kind == "span.completed")
        #expect(events.last?.output?["byteCount"] == .count(10))
        playback.cancel()
        #expect(events.count == 2)
    }

    @Test func captureEndCancelsOnlyTranscriptionsStillOutstanding() async {
        var events: [ShannonClientObserverEvent] = []
        let observer = ShannonVoiceObservation(automaticFlush: false, allowed: { true }, send: { batch, _ in events += batch; return true })
        observer.beginCapture(id: UUID(), model: "fixture")
        _ = observer.transcription(.speechStarted(itemID: "one"))
        _ = observer.transcription(.speechStarted(itemID: "two"))
        _ = observer.transcription(.inputTranscript("done", itemID: "one"))
        observer.endCapture()
        await observer.flush()
        #expect(events.filter { $0.kind == "span.cancelled" }.count == 1)
        #expect(events.filter { $0.kind == "span.completed" }.count == 1)
    }

    @Test func playbackCancellationNeverTurnsIntoCompletion() {
        var events: [ShannonClientObserverEvent] = []
        let playback = ShannonObservedPlayback(runID: UUID(), model: "fixture", emit: { events.append($0) })
        playback.scheduled(10)
        playback.played(4)
        playback.cancel()
        playback.finishScheduling()
        playback.played(6)
        #expect(events.map(\.kind) == ["span.started", "span.cancelled"])
        #expect(events.last?.output?["playedBytes"] == .count(4))
    }

    @Test func synthesisCorrelationStaysBoundToItsActualTask() async {
        let first = UUID(), second = UUID()
        async let one = ShannonObserverCorrelation.$runID.withValue(first) { await Task.yield(); return ShannonObserverCorrelation.runID }
        async let two = ShannonObserverCorrelation.$runID.withValue(second) { await Task.yield(); return ShannonObserverCorrelation.runID }
        let values = await (one, two)
        #expect(values.0 == first)
        #expect(values.1 == second)
        #expect(ShannonObserverCorrelation.runID == nil)
    }
}
