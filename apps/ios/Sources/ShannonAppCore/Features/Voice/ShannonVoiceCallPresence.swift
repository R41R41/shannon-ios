import Foundation

/// Tells the server that the owner is in a voice call with her on this device (`callStarted` when the session
/// was made, `callEnded` when the call ends), so that her desktop body keeps its wake listener closed and is not
/// heard taking her voice from this phone for his turns (`docs/body-contract.md`, "When the owner is in a call
/// elsewhere"). It sends whatever the touch setting is: the events carry no words, only that a call runs.
///
/// One call has one id; the end carries the id of its start, and an end without a start sends nothing. A session
/// made and then cancelled before the call began gets an end of its own, because the server already counted it.
/// The audience is the one at the start of the call; the server uses it for nothing.
///
/// An end must not be lost, or the desktop stays quiet until the server's own limit: it is kept on the device
/// (`UserDefaults`, a few small records) from the moment the call starts, sent under a little background time when
/// the call ends, and sent again at the next launch or return to the foreground if it did not get through, also for
/// a call the app was closed in. The events are sent in order, each retried a few times on a network failure.
@MainActor
public final class ShannonVoiceCallPresence {
    public static let shared = ShannonVoiceCallPresence()
    static let pendingKey = "shannon.voice.call-presence.pending-ends"
    static let pendingLimit = 4

    /// An end not yet delivered. `occurredAt` is nil while its call runs (or ran when the app was closed).
    struct PendingEnd: Codable, Equatable {
        let id: String
        let audience: ShannonBodyAudience
        var occurredAt: String?
        let scopeKey: String
    }

    var reporter: (any ShannonBodyCallReporting)?
    var scopeKey = ""
    var mayReport: @MainActor () -> Bool = { false }
    var now: () -> Date = Date.init
    var retryDelay: @Sendable (Int) async -> Void = { attempt in try? await Task.sleep(for: .seconds(Double(2 << attempt))) }
    var defaults: UserDefaults = .standard
    /// Holds background running time while an end is sent; returns what gives it back.
    var holdBackgroundTime: @MainActor (String) -> @MainActor () -> Void = ShannonVoiceCallPresence.backgroundTime
    private var call: (id: String, audience: ShannonBodyAudience)?
    private var sending: Task<Void, Never>?
    private var inFlight = Set<String>()

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
        // From now on the end is owed, also if the app is closed during the call.
        keep(PendingEnd(id: "call-\(id)-ended", audience: audience, occurredAt: nil, scopeKey: scopeKey))
        send(ShannonBodyCallEventDTO(id: "call-\(id)-started", type: .callStarted, audience: audience, occurredAt: timestamp()))
    }

    /// The call ended, or failed. Only a call that was reported as started is reported as ended.
    func ended() {
        guard let current = call else { return }
        call = nil
        let end = PendingEnd(id: "call-\(current.id)-ended", audience: current.audience, occurredAt: timestamp(), scopeKey: scopeKey)
        keep(end)
        sendEnd(end)
    }

    /// A session was made and the call was cancelled before it began: the server counted the session, so it hears the end.
    func abandoned(audience: ShannonBodyAudience) {
        guard call == nil, reporter != nil, mayReport() else { return }
        let end = PendingEnd(id: "call-\(UUID().uuidString.lowercased())-ended", audience: audience, occurredAt: timestamp(), scopeKey: scopeKey)
        keep(end)
        sendEnd(end)
    }

    /// At launch and on return to the foreground: sends every end that did not get through, except the running call's.
    func resendUndelivered(scopeKey: String, reporter: (any ShannonBodyCallReporting)?) {
        if self.reporter == nil, let reporter { configure(scopeKey: scopeKey, reporter: reporter, mayReport: { true }) }
        guard self.reporter != nil else { return }
        let running = call.map { "call-\($0.id)-ended" }
        for var end in pending() where end.id != running && !inFlight.contains(end.id) {
            if end.occurredAt == nil {
                // The app was closed during that call: it ended by now.
                end.occurredAt = timestamp()
                keep(end)
            }
            sendEnd(end)
        }
    }

    /// Waits until everything queued was sent or given up. For tests.
    func settle() async { await sending?.value }

    func pending() -> [PendingEnd] {
        guard let data = defaults.data(forKey: Self.pendingKey) else { return [] }
        return (try? JSONDecoder().decode([PendingEnd].self, from: data)) ?? []
    }

    private func keep(_ end: PendingEnd) {
        var ends = pending().filter { $0.id != end.id }
        ends.append(end)
        store(Array(ends.suffix(Self.pendingLimit)))
    }

    private func delivered(_ id: String) {
        store(pending().filter { $0.id != id })
    }

    private func store(_ ends: [PendingEnd]) {
        if ends.isEmpty { defaults.removeObject(forKey: Self.pendingKey) } else if let data = try? JSONEncoder().encode(ends) { defaults.set(data, forKey: Self.pendingKey) }
    }

    private func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now())
    }

    private func sendEnd(_ end: PendingEnd) {
        guard let occurredAt = end.occurredAt else { return }
        inFlight.insert(end.id)
        let release = holdBackgroundTime("shannon.call-presence.end")
        send(ShannonBodyCallEventDTO(id: end.id, type: .callEnded, audience: end.audience, occurredAt: occurredAt), scopeKey: end.scopeKey) { [weak self] done in
            self?.inFlight.remove(end.id)
            if done { self?.delivered(end.id) }
            release()
        }
    }

    /// Sends after everything queued before it. `finished(true)`: delivered or refused for good; `false`: try again later.
    private func send(_ event: ShannonBodyCallEventDTO, scopeKey: String? = nil, finished: (@MainActor (Bool) -> Void)? = nil) {
        guard let reporter else { finished?(false); return }
        let scopeKey = scopeKey ?? self.scopeKey
        let previous = sending
        let retryDelay = retryDelay
        sending = Task {
            await previous?.value
            var done = false
            for attempt in 0..<3 {
                do {
                    try await reporter.sendBodyCallEvent(scopeKey: scopeKey, event: event)
                    done = true
                    break
                } catch let refusal as ShannonBodyRefusal where refusal.status != 429 && refusal.status < 500 {
                    // Refused for good (switched off, an older server, not paired): sending it again helps nobody.
                    done = true
                    break
                } catch {
                    if attempt < 2 { await retryDelay(attempt) }
                }
            }
            finished?(done)
        }
    }

    private static func backgroundTime(_ name: String) -> @MainActor () -> Void {
#if os(iOS)
        let assertion = ShannonBackgroundAssertion(name: name)
        return { assertion.end() }
#else
        return {}
#endif
    }
}
