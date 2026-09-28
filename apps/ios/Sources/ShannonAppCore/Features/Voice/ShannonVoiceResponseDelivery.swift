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
@MainActor
final class ShannonVoicePlaybackDrain {
    enum Failure: Error { case timedOut }
    private var pending: Set<UUID> = []
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var deadlines: [UUID: Task<Void, Never>] = [:]

    func schedule() -> UUID {
        let ticket = UUID()
        pending.insert(ticket)
        return ticket
    }

    func played(_ ticket: UUID) {
        guard pending.remove(ticket) != nil, pending.isEmpty else { return }
        for id in Array(waiters.keys) { finish(id, result: .success(())) }
    }

    func cancel() {
        pending.removeAll()
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
                deadlines[id] = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    self?.finish(id, result: .failure(Failure.timedOut))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(id, result: .failure(CancellationError()))
            }
        }
    }

    private func finish(_ id: UUID, result: Result<Void, Error>) {
        deadlines.removeValue(forKey: id)?.cancel()
        waiters.removeValue(forKey: id)?.resume(with: result)
    }
}
