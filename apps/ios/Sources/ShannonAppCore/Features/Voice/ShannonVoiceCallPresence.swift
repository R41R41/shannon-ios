import Foundation

/// Tells the server that the owner is in a voice call with her on this device (`callStarted` when the session
/// was made, `callEnded` when the call ends), so that her desktop body keeps its wake listener closed and is not
/// heard taking her voice from this phone for his turns (`docs/body-contract.md`, "When the owner is in a call
/// elsewhere"). It sends whatever the touch setting is: the events carry no words, only that a call runs.
///
/// One call has one id; the end carries the id of its start, and an end without a start sends nothing. The events
/// of one call are sent in order, each retried a few times on a network failure or a server error.
@MainActor
public final class ShannonVoiceCallPresence {
    public static let shared = ShannonVoiceCallPresence()

    var reporter: (any ShannonBodyCallReporting)?
    var scopeKey = ""
    var mayReport: @MainActor () -> Bool = { false }
    var now: () -> Date = Date.init
    var retryDelay: @Sendable (Int) async -> Void = { attempt in try? await Task.sleep(for: .seconds(Double(2 << attempt))) }
    private var call: (id: String, audience: ShannonBodyAudience)?
    private var sending: Task<Void, Never>?

    init() {}

    /// The conversation's own client and scope, set when a call begins. Without a client that reports calls, nothing is sent.
    func configure(scopeKey: String, reporter: (any ShannonBodyCallReporting)?, mayReport: @escaping @MainActor () -> Bool) {
        self.scopeKey = scopeKey
        self.reporter = reporter
        self.mayReport = mayReport
    }

    /// A voice session was made. A call already running is not started twice.
    func began(audience: ShannonBodyAudience) {
        guard call == nil, reporter != nil, mayReport() else { return }
        let id = UUID().uuidString.lowercased()
        call = (id, audience)
        send(.callStarted, id: "call-\(id)-started", audience: audience)
    }

    /// The call ended, or failed. Only a call that was reported as started is reported as ended.
    func ended() {
        guard let current = call else { return }
        call = nil
        send(.callEnded, id: "call-\(current.id)-ended", audience: current.audience)
    }

    /// Waits until everything queued was sent or given up. For tests.
    func settle() async { await sending?.value }

    private func send(_ type: ShannonBodyCallEventDTO.Kind, id: String, audience: ShannonBodyAudience) {
        guard let reporter else { return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let event = ShannonBodyCallEventDTO(id: id, type: type, audience: audience, occurredAt: formatter.string(from: now()))
        let scopeKey = scopeKey
        let previous = sending
        let retryDelay = retryDelay
        sending = Task {
            await previous?.value
            for attempt in 0..<3 {
                do {
                    try await reporter.sendBodyCallEvent(scopeKey: scopeKey, event: event)
                    return
                } catch let refusal as ShannonBodyRefusal where refusal.status != 429 && refusal.status < 500 {
                    // Refused for good (switched off, an older server, not paired): sending it again helps nobody.
                    return
                } catch {
                    if attempt < 2 { await retryDelay(attempt) }
                }
            }
        }
    }
}
