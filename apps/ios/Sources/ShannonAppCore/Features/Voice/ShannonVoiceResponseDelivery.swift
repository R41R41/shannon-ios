import Foundation

/// A complete, visible answer handles input even if its optional audio fails.
/// An incomplete generation never acknowledges the input, including after partial speech.
struct ShannonVoiceResponseDelivery {
    private(set) var response: ShannonLiveVoiceDelegationResponseDTO?
    private(set) var scheduledAudioSeconds = 0.0

    mutating func complete(
        _ response: ShannonLiveVoiceDelegationResponseDTO,
        batch: ShannonPendingVoiceTurns.Batch,
        ledger: inout ShannonPendingVoiceTurns
    ) throws {
        guard !response.threadId.isEmpty,
              !response.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || response.voicePlan?.shouldRespond == false else {
            throw ShannonAPIError.invalidResponse
        }
        self.response = response
        ledger.acknowledge(batch)
    }

    mutating func scheduledAudio(seconds: Double) {
        scheduledAudioSeconds += max(0, seconds)
    }

    var failureMessage: String {
        if response != nil {
            return "返答はできていますが、音声を最後まで再生できませんでした。画面の返答をご確認ください。"
        }
        if scheduledAudioSeconds > 0 {
            return "返答が途中で止まりました。未完了の入力は保持しています。続けて話すか再送してください。"
        }
        return "返答を作れませんでした。入力は保持しています。続けて話すか再送してください。"
    }

    /// What happens to her voice already on its way when a response fails (owner decision
    /// 2026-10-05). A barge-in is not a failure: `interruptResponse` cancels and discards.
    enum QueuedSpeech: String, Equatable, Sendable {
        /// Generation stopped: every complete sentence already received is said, then the notice.
        case finishReceivedSentences = "finish_sentences"
        /// Synthesis failed: audio already scheduled plays out; nothing more is synthesized.
        case finishScheduledAudio = "finish_scheduled"
        /// Playback itself stalled: the queue is dropped.
        case discard
    }

    static func queuedSpeech(afterFailureAt stage: String) -> QueuedSpeech {
        switch stage {
        case "generation": .finishReceivedSentences
        case "playback": .discard
        default: .finishScheduledAudio
        }
    }

    static func errorCategory(_ error: Error) -> String {
        if let error = error as? URLError { return "url_\(error.code.rawValue)" }
        if let error = error as? ShannonAPIError {
            switch error {
            case .invalidResponse: return "invalid_response"
            case .rejected(let status): return "http_\(status)"
            default: return "api_failure"
            }
        }
        if error is ShannonVoicePlaybackDrain.Failure { return "playback_timeout" }
        return "other_failure"
    }
}

/// Tracks AVAudioPlayerNode's dataPlayedBack callbacks, not estimated PCM duration.
/// Invalidating tickets before stopping the node prevents stop callbacks acknowledging audio.
/// The watchdog is a stall bound: every played buffer restarts it, so a talk of several
/// minutes scheduled ahead of playback is waited for to its end.
@MainActor
final class ShannonVoicePlaybackDrain {
    enum Failure: Error { case timedOut }
    private var pending: Set<UUID> = []
    private var playedActions: [UUID: @MainActor () -> Void] = [:]
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var deadlines: [UUID: Task<Void, Never>] = [:]
    private var timeouts: [UUID: Duration] = [:]
    /// Each played buffer, with whether more audio is still queued behind it.
    var onProgress: (@MainActor (_ stillPlaying: Bool) -> Void)?

    var isPlaying: Bool { !pending.isEmpty }

    func schedule(onPlayed: (@MainActor () -> Void)? = nil) -> UUID {
        let ticket = UUID()
        pending.insert(ticket)
        if let onPlayed { playedActions[ticket] = onPlayed }
        return ticket
    }

    func played(_ ticket: UUID) {
        guard pending.remove(ticket) != nil else { return }
        playedActions.removeValue(forKey: ticket)?()
        onProgress?(!pending.isEmpty)
        guard pending.isEmpty else {
            for id in Array(waiters.keys) { armDeadline(id) }
            return
        }
        for id in Array(waiters.keys) { finish(id, result: .success(())) }
    }

    func cancel() {
        pending.removeAll()
        playedActions.removeAll()
        for id in Array(waiters.keys) { finish(id, result: .failure(CancellationError())) }
    }

    func wait(timeout: Duration = .seconds(180)) async throws {
        try Task.checkCancellation()
        guard !pending.isEmpty else { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                waiters[id] = continuation
                timeouts[id] = timeout
                armDeadline(id)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(id, result: .failure(CancellationError()))
            }
        }
    }

    private func armDeadline(_ id: UUID) {
        guard let timeout = timeouts[id] else { return }
        deadlines.removeValue(forKey: id)?.cancel()
        deadlines[id] = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            self?.finish(id, result: .failure(Failure.timedOut))
        }
    }

    private func finish(_ id: UUID, result: Result<Void, Error>) {
        timeouts.removeValue(forKey: id)
        deadlines.removeValue(forKey: id)?.cancel()
        waiters.removeValue(forKey: id)?.resume(with: result)
    }
}
