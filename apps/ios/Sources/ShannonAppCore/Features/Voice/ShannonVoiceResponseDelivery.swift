import Foundation

/// The provider withheld the reply for its content (`error` line with `code: "content_filter"`).
struct ShannonVoiceReplyWithheld: Error, Equatable {}

/// A complete, visible answer handles input even if its optional audio fails.
/// An incomplete generation acknowledges the input only when she already said part of the
/// answer: what she said is kept as her reply, so the retry does not say it again.
struct ShannonVoiceResponseDelivery {
    private(set) var response: ShannonLiveVoiceDelegationResponseDTO?
    private(set) var scheduledAudioSeconds = 0.0
    var spoken = ShannonVoiceSpokenReply()
    /// The spoken part of an unfinished answer was kept as her reply.
    private(set) var keptSpokenPart = false
    /// Whether writing that kept part to the conversation succeeded.
    private(set) var keptPartSaved = true
    /// The provider withheld the reply: nothing of it is shown or kept, and its input is dropped.
    private(set) var withheld = false

    mutating func keptPartNotSaved() {
        keptPartSaved = false
    }

    /// A withheld reply answers its input by not answering it: the input is acknowledged so it is
    /// not sent again with every later utterance.
    mutating func withdraw(batch: ShannonPendingVoiceTurns.Batch, ledger: inout ShannonPendingVoiceTurns) {
        guard response == nil else { return }
        withheld = true
        ledger.acknowledge(batch)
    }

    /// After a generation failure that was not withheld content: her reply is the part she said
    /// (marked as cut off), and the input it answered is acknowledged. Nil when she said nothing of it.
    mutating func keepSpokenPart(
        batch: ShannonPendingVoiceTurns.Batch,
        ledger: inout ShannonPendingVoiceTurns
    ) -> String? {
        guard response == nil, let reply = spoken.cutOffReply else { return nil }
        keptSpokenPart = true
        ledger.acknowledge(batch)
        return reply
    }

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
        if withheld {
            return "この返答は内容の制限により取り消されました。同じ入力は再送しません。"
        }
        if keptSpokenPart {
            return keptPartSaved
                ? "返答が途中で途切れました。話した部分までを会話に残しています。"
                : "返答が途中で途切れました。話した部分を会話履歴に保存できませんでした。"
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
        /// Playback itself stalled, or the provider withheld the reply: the queue is dropped.
        case discard
    }

    static func queuedSpeech(afterFailureAt stage: String, error: Error) -> QueuedSpeech {
        if error is ShannonVoiceReplyWithheld { return .discard }
        return switch stage {
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
        if error is ShannonVoiceReplyWithheld { return "content_filter" }
        if error is ShannonSpeechBusy { return "speech_busy" }
        return "other_failure"
    }
}

/// Which sentences of the answer she actually said, in order. Playback is FIFO, so the sentences
/// played are a prefix of those queued; the waiting phrase before the answer is not part of it.
struct ShannonVoiceSpokenReply: Sendable {
    private var pending: [(text: String, answer: Bool)] = []
    private(set) var said: [String] = []
    /// The feeling the answer was being acted with (the provisional plan), for a reply kept cut off.
    private(set) var emotion: ShannonVoiceTurnEmotionDTO?

    /// One sentence handed to speech. The waiting phrase is the first sentence when it equals the plan's.
    mutating func queued(_ text: String, waitingPhrase: String?, emotion: ShannonVoiceTurnEmotionDTO? = nil) {
        let waiting = pending.allSatisfy { !$0.answer } && said.isEmpty
            && text == waitingPhrase?.trimmingCharacters(in: .whitespacesAndNewlines)
        pending.append((text, !waiting))
        if !waiting, let emotion { self.emotion = emotion }
    }

    /// The first audio of `text` played. Sentences queued before it with no audio of their own
    /// (only emoji) were passed over and count as said.
    mutating func played(_ text: String) {
        guard let index = pending.firstIndex(where: { $0.text == text }) else { return }
        said += pending[...index].filter(\.answer).map(\.text)
        pending.removeFirst(index + 1)
    }

    /// What she said of an answer that did not finish, with a mark that it was cut off.
    var cutOffReply: String? {
        let text = said.joined()
        return text.isEmpty ? nil : text + "…"
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

    func wait(timeout: Duration = .seconds(20)) async throws {
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
