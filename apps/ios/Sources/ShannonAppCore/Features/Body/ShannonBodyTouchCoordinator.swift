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
        /// The reaction this line answers, the Talk a spoken answer continues, and how long the microphone stays open for it.
        public var reactionID = ""
        public var threadID: String?
        public var listenSeconds = 0
        /// Who was around when she was touched. A line said with others around is never spoken or listened for.
        public var audience = ShannonBodyAudience.owner
        /// True while her voice says it, or is about to: the bubble is then not also announced to VoiceOver.
        /// Set back to false when the line was not said aloud after all, so that it is announced then.
        public var isSpoken = false
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
        /// Whether her line is spoken (the body screen's 声で返す); otherwise it is the bubble only.
        public var repliesInVoice: @MainActor @Sendable () -> Bool = { false }
        /// Says the line and listens for his answer. Nil where nothing can speak.
        /// `heard` is called once with whether any of it was said aloud.
        public var speak: (@MainActor @Sendable (Line, _ heard: @escaping @MainActor (Bool) -> Void) async -> Void)?
        /// Stops a line that is being spoken or listened for.
        public var stopSpeaking: (@MainActor @Sendable () -> Void)?
        public var invokeTouchGesture: @MainActor @Sendable (String) async -> Bool? = { gesture in
            await ShannonLive2DStage.shared.invokeTouchGesture(gesture)
        }

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
    /// True while her line is being spoken: her figure is in the speaking phase.
    public private(set) var isSpeaking = false
    /// The touch vocabulary the server said last (registration, or her desktop body's presence). Until it says 2 or more,
    /// touches leave the device exactly as before vocabulary 2 existed (`docs/body-contract.md`, "The signal").
    @ObservationIgnored public private(set) var touchVocabulary = ShannonBodyTouchVocabulary.unsaid

    @ObservationIgnored public var environment: Environment
    @ObservationIgnored private let scopeKey: String
    @ObservationIgnored private let client: (any ShannonBodyServing)?
    @ObservationIgnored private var registered = false
    @ObservationIgnored private var pending: [(event: ShannonBodyTouchEventDTO, queuedAt: Date)] = []
    @ObservationIgnored private var isFlushing = false
    @ObservationIgnored private var isAsking = false
    @ObservationIgnored private var lineTask: Task<Void, Never>?
    @ObservationIgnored private let touchReflex = ShannonTouchReflexExecutor()

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
        default:
            return nil
        }
    }

    /// The owner switched reporting off: her line goes, and what was waiting to be sent is dropped.
    public func reportingChanged() {
        guard !environment.reportsTouch() else { return }
        environment.stopSpeaking?()
        pending.removeAll()
        delivery = .fine
        clearLine()
    }

    /// What the server said of touch vocabulary 2 elsewhere (her desktop body's presence): nil is a server that says nothing.
    public func serverSaid(touchVocabulary value: Int?) {
        touchVocabulary = ShannonBodyTouchVocabulary.said(value)
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
        guard let client, !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }
        // A `400` to a batch with vocabulary-2 fields is asked about once: the server may have been rolled back.
        var askedAgain = false
        // Touches that arrive while a batch is under way are sent by the next turn of this loop.
        while !pending.isEmpty {
            let batch = pending.map(\.event)
            var sentDetail = false
            do {
                // Only a device that registered as a (touch-only) body reports what happened to it.
                if !registered { try await register(client) }
                // Switched off while registering: nothing is sent, nothing stays queued.
                guard sends else {
                    pending.removeAll()
                    return
                }
                let sent = batch.map { $0.sent(touchVocabulary: touchVocabulary) }
                sentDetail = sent.contains { $0.detail != .none }
                try await client.sendBodyTouches(scopeKey: scopeKey, events: sent)
                pending.removeAll { item in batch.contains { $0.id == item.event.id } }
                delivery = .fine
                for event in batch { Task { await self.applyTouchReflex(event.id, audience: event.audience, client: client) } }
            } catch let refusal as ShannonBodyRefusal {
                if refusal.status == 400, sentDetail, !askedAgain {
                    askedAgain = true
                    // Sent in the old shape if the server no longer says vocabulary 2; otherwise dropped below as before.
                    if await saysOldVocabularyAgain(client) { continue }
                }
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
                break
            } catch {
                delivery = .failed
                break
            }
        }
        // Switched off while a request was under way: nothing stays queued.
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
            show(answer, audience: request.audience)
            Task { await self.applyTouchReflex(request.id, audience: request.audience, client: client) }
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

    private func applyTouchReflex(_ touchID: String, audience: ShannonBodyAudience, client: any ShannonBodyServing) async {
        guard sends else { return }
        do {
            guard let directive = try await client.claimTouchReflex(scopeKey: scopeKey, touchId: touchID), directive.touchId == touchID else { return }
            let outcome = await touchReflex.perform(directive, now: environment.now(),
                allowed: { self.sends && self.environment.audience() == audience },
                gestures: environment.capabilities().gestures, invoke: environment.invokeTouchGesture)
            try await client.reportTouchReflex(scopeKey: scopeKey, operationId: directive.operationId, outcome: outcome)
        } catch { /* The server keeps an unknown receipt; neither the gesture nor speech is replayed. */ }
    }

    /// Registers as a touch-only body before the first request, and once more if the server does not know this device.
    private func answer(to request: ShannonBodyReactionRequestDTO, client: any ShannonBodyServing) async throws -> ShannonBodyReactionAnswerDTO {
        if !registered { try await register(client) }
        // Switched off while registering: the question is not asked.
        guard sends else { throw CancellationError() }
        let sent = request.sent(touchVocabulary: touchVocabulary)
        do {
            return try await client.askBodyReaction(sent)
        } catch let refusal as ShannonBodyRefusal where refusal.code == "BODY_REACTION_NOT_A_BODY" {
            registered = false
            try await register(client)
            return try await client.askBodyReaction(request.sent(touchVocabulary: touchVocabulary))
        } catch let refusal as ShannonBodyRefusal where refusal.status == 400 && sent.touch.detail != .none {
            // The server may have been rolled back: asked once more in the old shape if it no longer says vocabulary 2.
            guard await saysOldVocabularyAgain(client) else { throw refusal }
            return try await client.askBodyReaction(request.sent(touchVocabulary: touchVocabulary))
        }
    }

    private func register(_ client: any ShannonBodyServing) async throws {
        let capabilities = environment.capabilities()
        touchVocabulary = try await client.registerTouchBody(
            scopeKey: scopeKey, expressions: capabilities.expressions, gestures: capabilities.gestures)
        registered = true
    }

    /// Registers again to hear the server's vocabulary afresh. True when it now says less than 2.
    private func saysOldVocabularyAgain(_ client: any ShannonBodyServing) async -> Bool {
        registered = false
        do { try await register(client) } catch { return false }
        return touchVocabulary < ShannonBodyTouchVocabulary.detailed
    }

    private func show(_ answer: ShannonBodyReactionAnswerDTO, audience: ShannonBodyAudience) {
        let message = answer.status == "said" ? answer.message : nil
        if let expression = message?.expression ?? answer.mood?.expression {
            environment.express(expression, message?.expression != nil ? message?.feeling : answer.mood?.feeling)
        }
        guard let message, !message.text.isEmpty else { return }
        let face = message.expression.flatMap(ShannonExpressionDTO.known).map { ShannonFace(expression: $0, feelingName: message.feeling) }
        // Voice mode, the owner alone, and nothing else holding the sound: the bubble and her voice, then a moment
        // in which he may answer. Otherwise the bubble only.
        let speaks = audience == .owner && environment.speak != nil && !isSpeaking && environment.repliesInVoice()
        let shown = Line(
            id: message.id, text: String(message.text.prefix(120)), face: face,
            reactionID: answer.id, threadID: message.threadId, listenSeconds: min(30, max(0, message.listenSeconds ?? 0)),
            audience: audience, isSpoken: speaks)
        line = shown
        if speaks, let speak = environment.speak {
            isSpeaking = true
            Task { [weak self] in
                await speak(shown) { [weak self] heard in
                    // Not said aloud after all (her voice came too late, or the sound was taken): VoiceOver reads the bubble.
                    guard let self, !heard, self.line == shown else { return }
                    self.line?.isSpoken = false
                }
                self?.isSpeaking = false
            }
        }
        lineTask?.cancel()
        lineTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.lineSeconds))
            guard !Task.isCancelled, let self, self.line == shown else { return }
            self.line = nil
        }
    }
}
