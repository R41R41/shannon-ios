import Foundation
import Observation

/// What a touch on her Live2D figure becomes. With 「体に起きたことをシャノンに伝える」 off
/// (the default) it becomes nothing: the page animates and no request leaves the device.
/// With it on, a finished touch is reported as a fact and, at the page's moment, she is asked
/// whether she says something. On the phone a finger touch is mostly too short for the page's moment,
/// so the app asks about such a finished touch itself (`Environment.asksAfterShortTouch`).
/// Her line is shown near the figure, and spoken where the surface answers in voice. During a voice
/// conversation on this device the page asks nothing, so the app asks about a finished touch itself and
/// her line is said in the call (`Environment.call`, `docs/body-contract.md`).
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
        /// A finger on the phone (`docs/body-contract.md`, "A body that only feels touch"): a finished touch the page never
        /// asks about (a stroke, a resting finger, a held hand or a tickle shorter than the page's 0.6 s) is asked about
        /// by the app itself when it ends. Off for a mouse, whose touches are long enough for the page's own moment.
        public var asksAfterShortTouch = false
        /// The page's own rule for its question: none while her phase is not idle (a voice conversation, a text reply on
        /// its way, a line of hers being said).
        public var pageIsIdle: @MainActor @Sendable () -> Bool = { ShannonLive2DStage.shared.phase == .idle }
        /// The voice conversation on this device, where there is one (the iPhone). Nil: no call is known here.
        public var call: CallLine?

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

    /// A voice conversation on this device, seen from a touch (owner, 2026-10-14: 「音声会話中に触っても反応がない」).
    /// While it runs the page asks about no touch (its phase is not idle), so the app asks about a finished one itself,
    /// and her answer is said in the call, in the call's voice, as her next words: never over his words or her reply.
    public struct CallLine: Sendable {
        /// A call is running on this device (also while it connects, thinks or speaks).
        public var isLive: @MainActor @Sendable () -> Bool
        /// Her line could be said in it now: an owner call that is listening, no words of his being heard or waiting
        /// for her reply, no reply of hers under way, nobody else around.
        public var mayHear: @MainActor @Sendable () -> Bool
        /// Says the line in the call. True when any of it sounded.
        public var say: @MainActor @Sendable (Line) async -> Bool

        public init(
            isLive: @escaping @MainActor @Sendable () -> Bool, mayHear: @escaping @MainActor @Sendable () -> Bool,
            say: @escaping @MainActor @Sendable (Line) async -> Bool
        ) {
            self.isLive = isLive
            self.mayHear = mayHear
            self.say = say
        }
    }

    public static let lineSeconds = 7.0
    /// The page asks about a finished touch only from this long (`pet` and the rest; a `poke` always): the embed's
    /// `README.md`, `askReaction`. Shorter ones, nearly every finger touch on a phone, it never asks about.
    static let pageAsksAtEndMilliseconds = 600
    /// At most one question in about 45 seconds, the page's spacing, counted over the page's questions and the app's own.
    static let askSpacingSeconds: TimeInterval = 45
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
    /// The touches a question was already sent for (the page's or the app's), newest last, and when the last ones were sent.
    @ObservationIgnored private var askedTouchIDs: [String] = []
    @ObservationIgnored private var lastAskAt: Date?
    @ObservationIgnored private var lastOwnAskAt: Date?

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
            let audience = environment.audience()
            let event = ShannonBodyTouchEventDTO(touch: touch, audience: audience)
            guard asksItself(touch, audience: audience) else {
                enqueue(event)
                return Task { await self.flush() }
            }
            // The question goes first, so that it is the touch's first message (the one her feeling and her stance are
            // taken from); the finished touch follows as its event with the same id, as after any question of the page.
            noteAsked(touch.id, own: true)
            let request = ShannonBodyReactionRequestDTO(scopeKey: scopeKey, touch: touch, audience: audience)
            return Task {
                await self.ask(request)
                guard self.sends else { return }
                self.enqueue(event)
                await self.flush()
            }
        case let .askReaction(touch):
            guard sends, !isAsking else { return nil }
            // Inside the spacing of a question the app asked itself, the page's question is not sent: one in about 45 seconds.
            if let lastOwnAskAt, environment.now().timeIntervalSince(lastOwnAskAt) < Self.askSpacingSeconds { return nil }
            noteAsked(touch.id, own: false)
            let request = ShannonBodyReactionRequestDTO(scopeKey: scopeKey, touch: touch, audience: environment.audience())
            return Task { await self.ask(request) }
        default:
            return nil
        }
    }

    /// Whether the app asks about this finished touch itself, outside the 45 s spacing: during a voice conversation on this
    /// device any finished touch, while her line could be said in the call now (the page asks nothing then); otherwise a
    /// finger on the phone, a touch the page asked nothing about and never will (not a poke, shorter than its 0.6 s), while
    /// the page would ask at all.
    private func asksItself(_ touch: ShannonLive2DTouch, audience: ShannonBodyAudience) -> Bool {
        guard !isAsking, !isSpeaking, !touch.ongoing, touch.kind != .carry, !askedTouchIDs.contains(touch.id) else { return false }
        if let call = environment.call, call.isLive() {
            guard audience == .owner, call.mayHear() else { return false }
        } else {
            guard environment.asksAfterShortTouch, touch.kind != .poke, touch.durationMs < Self.pageAsksAtEndMilliseconds,
                  environment.pageIsIdle() else { return false }
        }
        if let lastAskAt, environment.now().timeIntervalSince(lastAskAt) < Self.askSpacingSeconds { return false }
        return true
    }

    private func noteAsked(_ id: String, own: Bool) {
        let now = environment.now()
        lastAskAt = now
        if own { lastOwnAskAt = now }
        askedTouchIDs.append(id)
        if askedTouchIDs.count > 32 { askedTouchIDs.removeFirst(askedTouchIDs.count - 32) }
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

    /// Who says her line aloud, if anyone. In a voice conversation on this device: the call, when it could hear her line
    /// now (otherwise the bubble only: never over his words or her reply). Outside one: voice mode, the owner alone and
    /// nothing else holding the sound, then a moment in which he may answer. Otherwise nobody: the bubble only.
    private func voiceFor(audience: ShannonBodyAudience) -> (@MainActor @Sendable (Line, _ heard: @escaping @MainActor (Bool) -> Void) async -> Void)? {
        guard audience == .owner, !isSpeaking else { return nil }
        if let call = environment.call, call.isLive() {
            guard call.mayHear() else { return nil }
            return { line, heard in heard(await call.say(line)) }
        }
        guard let speak = environment.speak, environment.repliesInVoice() else { return nil }
        return speak
    }

    private func show(_ answer: ShannonBodyReactionAnswerDTO, audience: ShannonBodyAudience) {
        let message = answer.status == "said" ? answer.message : nil
        if let expression = message?.expression ?? answer.mood?.expression {
            environment.express(expression, message?.expression != nil ? message?.feeling : answer.mood?.feeling)
        }
        guard let message, !message.text.isEmpty else { return }
        let face = message.expression.flatMap(ShannonExpressionDTO.known).map { ShannonFace(expression: $0, feelingName: message.feeling) }
        let voice = voiceFor(audience: audience)
        let shown = Line(
            id: message.id, text: String(message.text.prefix(120)), face: face,
            reactionID: answer.id, threadID: message.threadId, listenSeconds: min(30, max(0, message.listenSeconds ?? 0)),
            audience: audience, isSpoken: voice != nil)
        line = shown
        if let voice {
            isSpeaking = true
            Task { [weak self] in
                await voice(shown) { [weak self] heard in
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
