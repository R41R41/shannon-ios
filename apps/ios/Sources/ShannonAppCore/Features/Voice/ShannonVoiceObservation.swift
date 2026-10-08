import Foundation

/// In-memory, bounded observation of work the native voice path actually performed.
/// Projections contain counts and explicit IDs only; no transcript or PCM buffer is queued.
@MainActor
final class ShannonVoiceObservation {
    private let allowed: @MainActor () -> Bool
    private let send: @MainActor ([ShannonClientObserverEvent], Int) async -> Bool
    private let automaticFlush: Bool
    private var queue: [ShannonClientObserverEvent] = []
    private var droppedEvents = 0
    private var flushTask: Task<Void, Never>?
    private var captureID: UUID?
    private var transcriptionModel = ""
    private var pcmSpan: UUID?
    private var pcmStarted = Date()
    private var pcmBytes = 0
    private var transcriptions: [String: UUID] = [:]
    private var accepted: [UUID] = []
    private var joins: [UUID: UUID] = [:]
    private var playback: [UUID: ShannonObservedPlayback] = [:]
    var queuedCount: Int { queue.count }

    init(automaticFlush: Bool = true, allowed: @escaping @MainActor () -> Bool,
         send: @escaping @MainActor ([ShannonClientObserverEvent], Int) async -> Bool) {
        self.automaticFlush = automaticFlush; self.allowed = allowed; self.send = send
    }

    func enqueue(_ event: ShannonClientObserverEvent) {
        guard allowed() else { queue.removeAll(); droppedEvents = 0; return }
        guard queue.count < 64 else { dropped(1); return }
        queue.append(event)
        guard automaticFlush, flushTask == nil else { return }
        flushTask = Task { @MainActor [weak self] in
            var attemptedLossOnly = false
            while let self, !self.queue.isEmpty || (!attemptedLossOnly && self.droppedEvents > 0) {
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
                // At most one loss-only attempt per active drain; offline loss waits for new real events.
                if self.queue.isEmpty { attemptedLossOnly = true }
                await self.flush()
            }
            self?.flushTask = nil
        }
    }

    func flush() async {
        guard allowed() else { queue.removeAll(); droppedEvents = 0; return }
        let batch = Array(queue.prefix(16))
        queue.removeFirst(batch.count)
        let reportedDrops = droppedEvents
        droppedEvents = 0
        guard !batch.isEmpty || reportedDrops > 0 else { return }
        let accepted = await send(batch, reportedDrops)
        guard allowed() else { queue.removeAll(); droppedEvents = 0; return }
        // Lost payloads are never replayed. Keep only their count and any unacknowledged loss report.
        if !accepted { dropped(batch.count + reportedDrops) }
    }

    private func dropped(_ count: Int) { droppedEvents = min(4_096, droppedEvents + count) }

    func beginCapture(id: UUID, model: String) {
        endCapture()
        captureID = id; transcriptionModel = model
    }

    func pcmSent(byteCount: Int) {
        guard allowed(), let captureID, byteCount > 0 else { return }
        if pcmSpan == nil {
            pcmSpan = UUID(); pcmStarted = Date()
            enqueue(.init(runId: captureID, spanId: pcmSpan!, node: "pcm", kind: "span.started",
                input: ["sampleRate": .count(24_000), "channels": .count(1), "bitsPerSample": .count(16)]))
        }
        pcmBytes += byteCount
        if Date().timeIntervalSince(pcmStarted) >= 1 { finishPCM() }
    }

    private func finishPCM() {
        guard let captureID, let span = pcmSpan else { return }
        enqueue(.init(runId: captureID, spanId: span, node: "pcm", kind: "span.completed",
            output: ["byteCount": .count(pcmBytes), "sampleCount": .count(pcmBytes / 2), "destination": .text("transcription-socket")]))
        enqueue(.init(runId: captureID, spanId: UUID(), node: "stt", kind: "handoff",
            output: ["byteCount": .count(pcmBytes)], fromNode: "pcm", toNode: "stt", sourceSpanId: span))
        pcmSpan = nil; pcmBytes = 0
    }

    func transcription(_ event: ShannonTranscriptionEvent) -> UUID? {
        guard allowed(), let captureID else { return nil }
        switch event {
        case let .speechStarted(itemID):
            guard let itemID else { return nil }
            let span = UUID()
            if transcriptions.count >= 32 { dropped(transcriptions.count); transcriptions.removeAll() }
            transcriptions[itemID] = span
            enqueue(.init(runId: captureID, spanId: span, node: "stt", kind: "span.started",
                input: ["model": .text(transcriptionModel), "provider": .text("openai")]))
        case let .inputTranscript(text, itemID):
            let span = itemID.flatMap { transcriptions.removeValue(forKey: $0) } ?? UUID()
            enqueue(.init(runId: captureID, spanId: span, node: "stt", kind: "span.completed",
                output: ["characterCount": .count(text.count), "model": .text(transcriptionModel), "provider": .text("openai")]))
            return span
        default: break
        }
        return nil
    }

    func acceptedTranscript(_ span: UUID?) {
        guard let span else { return }
        guard accepted.count < 32 else { dropped(1); return }
        accepted.append(span)
    }

    func discardUnjoined() { accepted.removeAll() }

    func joined(id: UUID, characterCount: Int, segmentCount: Int) {
        defer { accepted.removeAll() }
        guard allowed(), let captureID else { return }
        let span = UUID()
        if joins.count >= 32 { dropped(joins.count); joins.removeAll() }
        joins[id] = span
        enqueue(.init(runId: id, spanId: span, parentSpanId: accepted.last, node: "join", kind: "span.completed",
            input: ["captureRunId": .text(captureID.uuidString), "segmentCount": .count(segmentCount)],
            output: ["characterCount": .count(characterCount), "utteranceId": .text(id.uuidString)]))
        for source in accepted {
            enqueue(.init(runId: id, spanId: UUID(), node: "join", kind: "handoff",
                output: ["captureRunId": .text(captureID.uuidString)], fromNode: "stt", toNode: "join", sourceSpanId: source))
        }
    }

    func delegating(id: UUID, utteranceIDs: [UUID]) {
        for utterance in utteranceIDs {
            guard let span = joins[utterance] else { continue }
            enqueue(.init(runId: id, spanId: UUID(), node: "join", kind: "handoff",
                output: ["utteranceRunId": .text(utterance.uuidString)], fromNode: "join", toNode: "perception", sourceSpanId: span))
        }
    }

    func beginPlayback(runID: UUID, model: String) -> ShannonObservedPlayback {
        let span = ShannonObservedPlayback(runID: runID, model: model) { [weak self] event in
            self?.enqueue(event)
            if event.kind != "span.started" { self?.playback.removeValue(forKey: event.spanId) }
        }
        // An overfull observation buffer drops tracking; it never declares real playback cancelled.
        if playback.count >= 32, let first = playback.keys.first { dropped(1); playback.removeValue(forKey: first) }
        playback[span.id] = span
        return span
    }

    func cancelPlayback() {
        for span in Array(playback.values) { span.cancel() }
        playback.removeAll()
    }

    func endCapture() {
        finishPCM(); cancelPlayback()
        if let captureID {
            for span in transcriptions.values {
                enqueue(.init(runId: captureID, spanId: span, node: "stt", kind: "span.cancelled", output: ["reason": .text("capture-ended")]))
            }
        }
        captureID = nil; transcriptions.removeAll(); accepted.removeAll(); joins.removeAll()
    }
}

/// Completion is driven only by AVAudioPlayerNode's .dataPlayedBack callbacks.
@MainActor
final class ShannonObservedPlayback {
    let id = UUID()
    private let runID: UUID
    private let emit: @MainActor (ShannonClientObserverEvent) -> Void
    private var scheduledBytes = 0
    private var playedBytes = 0
    private var schedulingEnded = false
    private var ended = false
    init(runID: UUID, model: String, emit: @escaping @MainActor (ShannonClientObserverEvent) -> Void) {
        self.runID = runID; self.emit = emit
        emit(.init(runId: runID, spanId: id, node: "play", kind: "span.started", input: ["model": .text(model)]))
    }
    func scheduled(_ bytes: Int) { scheduledBytes += bytes }
    func played(_ bytes: Int) { guard !ended else { return }; playedBytes += bytes; completeIfPlayed() }
    func finishScheduling() { schedulingEnded = true; completeIfPlayed() }
    private func completeIfPlayed() {
        guard !ended, schedulingEnded, scheduledBytes > 0, playedBytes == scheduledBytes else { return }
        ended = true
        emit(.init(runId: runID, spanId: id, node: "play", kind: "span.completed",
            output: ["byteCount": .count(playedBytes), "sampleCount": .count(playedBytes / 2)]))
    }
    func cancel() {
        guard !ended else { return }; ended = true
        emit(.init(runId: runID, spanId: id, node: "play", kind: "span.cancelled",
            output: ["scheduledBytes": .count(scheduledBytes), "playedBytes": .count(playedBytes)]))
    }
}
