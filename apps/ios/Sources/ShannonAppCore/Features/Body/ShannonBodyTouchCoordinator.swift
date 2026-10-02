import Foundation
import Observation

/// What a touch on her Live2D figure becomes. With 「体に起きたことをシャノンに伝える」 off
/// (the default) it becomes nothing: the page animates and no request leaves the device.
/// With it on, a finished touch is reported as a fact and, at the page's moment, she is asked
/// whether she says something. Her line is shown near the figure; it is not spoken and no
/// microphone opens (the app has no speech outside a call).
@MainActor
@Observable
public final class ShannonBodyTouchCoordinator {
    public struct Line: Equatable, Identifiable, Sendable {
        public let id: String
        public let text: String
        public let face: ShannonFace?
    }

    /// What the body screen may truthfully say about delivery.
    public enum Delivery: Equatable, Sendable {
        case fine, notConnected, failed, unsupported
    }

    public struct Environment: Sendable {
        public var reportsTouch: @MainActor @Sendable () -> Bool
        public var audience: @MainActor @Sendable () -> ShannonBodyAudience
        /// False in a design preview: nothing is sent.
        public var maySend: @MainActor @Sendable () -> Bool
        public var capabilities: @MainActor @Sendable () -> (expressions: [String], gestures: [String])
        public var express: @MainActor @Sendable (_ expression: String, _ feeling: String?) -> Void
        public var now: @Sendable () -> Date

        public init(
            reportsTouch: @escaping @MainActor @Sendable () -> Bool = { ShannonBodyPreference.reportsTouch() },
            audience: @escaping @MainActor @Sendable () -> ShannonBodyAudience = { .owner },
            maySend: @escaping @MainActor @Sendable () -> Bool = { true },
            capabilities: @escaping @MainActor @Sendable () -> (expressions: [String], gestures: [String]) = {
                (ShannonLive2DStage.shared.expressions, ShannonLive2DStage.shared.gestures)
            },
            express: @escaping @MainActor @Sendable (String, String?) -> Void = { expression, feeling in
                ShannonLive2DStage.shared.express(expression, feeling: feeling)
            },
            now: @escaping @Sendable () -> Date = { Date() }
        ) {
            self.reportsTouch = reportsTouch
            self.audience = audience
            self.maySend = maySend
            self.capabilities = capabilities
            self.express = express
            self.now = now
        }
    }

    public static let lineSeconds = 7.0
    static let pendingLimit = 50
    static let pendingMaximumAge: TimeInterval = 24 * 60 * 60

    public private(set) var line: Line?
    public private(set) var delivery: Delivery = .fine

    @ObservationIgnored public var environment: Environment
    @ObservationIgnored private let scopeKey: String
    @ObservationIgnored private let client: (any ShannonBodyServing)?
    @ObservationIgnored private var registered = false
    @ObservationIgnored private var pending: [(event: ShannonBodyTouchEventDTO, queuedAt: Date)] = []
    @ObservationIgnored private var isFlushing = false
    @ObservationIgnored private var isAsking = false
    @ObservationIgnored private var lineTask: Task<Void, Never>?

    public init(scopeKey: String = "local-owner", client: (any ShannonBodyServing)? = nil, environment: Environment = Environment()) {
        self.scopeKey = scopeKey
        self.client = client
        self.environment = environment
    }

    private var sends: Bool { client != nil && environment.reportsTouch() && environment.maySend() }

    /// A message of the page. Returns the work it started, for tests.
    @discardableResult
    public func handle(_ message: ShannonLive2DMessage) -> Task<Void, Never>? {
        switch message {
        case let .touch(touch):
            guard sends else { return nil }
            // Who was around is decided when the touch happens, not when it is delivered.
            enqueue(ShannonBodyTouchEventDTO(touch: touch, audience: environment.audience()))
            return Task { await self.flush() }
        case let .askReaction(touch):
            guard sends, !isAsking else { return nil }
            let request = ShannonBodyReactionRequestDTO(scopeKey: scopeKey, touch: touch, audience: environment.audience())
            return Task { await self.ask(request) }
        case .ready, .error, .tap, .frameStats:
            return nil
        }
    }

    /// The owner switched reporting off: her line goes, and what was waiting to be sent is dropped.
    public func reportingChanged() {
        guard !environment.reportsTouch() else { return }
        pending.removeAll()
        delivery = .fine
        clearLine()
    }

    public func clearLine() {
        lineTask?.cancel()
        lineTask = nil
        line = nil
    }

    private func enqueue(_ event: ShannonBodyTouchEventDTO) {
        let now = environment.now()
        pending.removeAll { now.timeIntervalSince($0.queuedAt) > Self.pendingMaximumAge }
        pending.append((event, now))
        if pending.count > Self.pendingLimit { pending.removeFirst(pending.count - Self.pendingLimit) }
    }

    private func flush() async {
        guard let client, !isFlushing, !pending.isEmpty else { return }
        isFlushing = true
        defer { isFlushing = false }
        let batch = pending.map(\.event)
        do {
            // Only a device that registered as a (touch-only) body reports what happened to it.
            if !registered { try await register(client) }
            try await client.sendBodyTouches(scopeKey: scopeKey, events: batch)
            pending.removeAll { item in batch.contains { $0.id == item.event.id } }
            delivery = .fine
        } catch let refusal as ShannonBodyRefusal {
            switch refusal.status {
            case 401:
                delivery = .notConnected
            case 400, 403, 404, 405:
                // Switched off on the server, an older server, or a batch it will never take: keeping it helps nobody.
                pending.removeAll()
                delivery = .unsupported
            default:
                delivery = .failed
            }
        } catch {
            delivery = .failed
        }
        // Switched off while the request was under way: nothing stays queued.
        if !environment.reportsTouch() { pending.removeAll() }
    }

    private func ask(_ request: ShannonBodyReactionRequestDTO) async {
        guard let client else { return }
        isAsking = true
        defer { isAsking = false }
        let startedAt = environment.now()
        do {
            let answer = try await answer(to: request, client: client)
            // Late words are not said, and words for a switch that is now off are not shown.
            guard environment.now().timeIntervalSince(startedAt) <= ShannonBodyRegistration.reactionTimeoutSeconds,
                  environment.reportsTouch() else { return }
            delivery = .fine
            show(answer)
        } catch let refusal as ShannonBodyRefusal {
            switch refusal.status {
            case 401: delivery = .notConnected
            case 403, 404, 405: delivery = .unsupported
            case 409, 429: break
            default: delivery = .failed
            }
        } catch {
            // A timeout is her staying quiet, not a failure to report: the finished touch is still sent as an event.
        }
    }

    /// Registers as a touch-only body before the first request, and once more if the server does not know this device.
    private func answer(to request: ShannonBodyReactionRequestDTO, client: any ShannonBodyServing) async throws -> ShannonBodyReactionAnswerDTO {
        if !registered { try await register(client) }
        do {
            return try await client.askBodyReaction(request)
        } catch let refusal as ShannonBodyRefusal where refusal.code == "BODY_REACTION_NOT_A_BODY" {
            registered = false
            try await register(client)
            return try await client.askBodyReaction(request)
        }
    }

    private func register(_ client: any ShannonBodyServing) async throws {
        let capabilities = environment.capabilities()
        try await client.registerTouchBody(scopeKey: scopeKey, expressions: capabilities.expressions, gestures: capabilities.gestures)
        registered = true
    }

    private func show(_ answer: ShannonBodyReactionAnswerDTO) {
        let message = answer.status == "said" ? answer.message : nil
        if let expression = message?.expression ?? answer.mood?.expression {
            environment.express(expression, message?.expression != nil ? message?.feeling : answer.mood?.feeling)
        }
        guard let message, !message.text.isEmpty else { return }
        let face = message.expression.flatMap(ShannonExpressionDTO.init(rawValue:)).map { ShannonFace(expression: $0, feelingName: message.feeling) }
        let shown = Line(id: message.id, text: String(message.text.prefix(120)), face: face)
        line = shown
        lineTask?.cancel()
        lineTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.lineSeconds))
            guard !Task.isCancelled, let self, self.line == shown else { return }
            self.line = nil
        }
    }
}
