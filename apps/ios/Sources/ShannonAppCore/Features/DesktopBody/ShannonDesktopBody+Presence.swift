#if os(macOS)
import Foundation

/// What her desktop body reads and reports while its window is up: her presence (polled as the server asks), who is at
/// the Mac (`ownerAway` / `ownerReturned`), her own messages and the lines of a moment (`reach.body-speaking`).
extension ShannonDesktopBody {
    static let shownReachOutsKey = "shannon.desktop-body.shown-reach-outs"

    func startLoops() {
        if loop == nil { loop = Task { [weak self] in await self?.runPresence() } }
        if minuteTask == nil { minuteTask = Task { [weak self] in await self?.runMac() } }
    }

    /// Reads presence only while her window is up: a read is how the server knows that she is showing.
    private func runPresence() async {
        var wait = 0.0
        while !Task.isCancelled {
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, isShown else { return }
            wait = await pollOnce()
        }
    }

    /// One read; answers how long to wait for the next.
    func pollOnce() async -> Double {
        guard let client, let conversation, !conversation.isDesignPreview else { return 60 }
        do {
            // Until the server has said that it hears the body as a body, the read says nothing of who is present.
            let probing = support != .supported
            let (presence, heard) = try await client.bodyPresence(
                scopeKey: conversation.scopeKey, etag: probing ? nil : etag, audience: probing ? nil : audience)
            guard heard else {
                // An older server would take the window for the app itself: nothing is registered or sent.
                support = .unsupported
                registeredCamera = nil
                return 600
            }
            if probing {
                support = .supported
                await registerIfNeeded(force: true)
                if !reportedAppStarted { report(plain: "appStarted") }
                reportedAppStarted = true
                report(plain: "windowShown")
            }
            etag = presence.etag
            if presence.unchanged != true { apply(presence) }
            return Double(min(10, max(3, presence.pollAfterSeconds ?? 10)))
        } catch let refusal as ShannonBodyRefusal {
            if refusal.status == 401 {
                // A new pairing is a new device: it registers again before it reads her messages.
                support = .notConnected
                registeredCamera = nil
            }
            return 30
        } catch {
            return 15
        }
    }

    /// The server holds her registration as a full body (the last registration succeeded).
    var isRegistered: Bool { registeredCamera != nil }

    /// Registers her full body (`surface: "mac"`), and again whenever the camera flag changes.
    func registerIfNeeded(force: Bool = false) async {
        guard let client, let conversation, support == .supported, isShown, !conversation.isDesignPreview else { return }
        let camera = registersCamera
        guard force || registeredCamera != camera else { return }
        let stage = ShannonLive2DStage.shared
        do {
            try await client.registerDesktopBody(scopeKey: conversation.scopeKey, expressions: stage.expressions, gestures: stage.gestures, camera: camera)
            registeredCamera = camera
        } catch {
            registeredCamera = nil
        }
    }

    func apply(_ presence: ShannonDesktopBodyPresenceDTO) {
        let stage = ShannonLive2DStage.shared
        if let mood = presence.mood {
            if let valence = mood.valence, let arousal = mood.arousal, let openness = mood.openness {
                stage.setMood(valence: valence, arousal: arousal, openness: openness)
            }
            let lingers = mood.fromConversation == true
            stage.setPresence(ShannonLive2DPresence(
                expression: lingers ? mood.expression : nil, feeling: lingers ? mood.feeling : nil,
                intensity: lingers ? (mood.intensity ?? 0) : 0, doing: presence.doing ?? "idle",
                awaitingReaction: presence.study?.awaitingReaction ?? 0))
        }
        ownerInCallElsewhere = presence.ownerCallElsewhere?.active ?? false
        let waiting = presence.study?.awaitingReaction ?? 0
        // One more story waits for his reaction: the line of that moment, when it may be said.
        if waiting > awaitingReaction { enqueue { await self.sayNudge("awaitingReaction") } }
        awaitingReaction = waiting
        if let look = presence.look, !answeredLooks.contains(look.id) {
            answeredLooks.insert(look.id)
            Task { await self.takeLook(look) }
        }
        // Only as her registered body: unregistered, the server would take the read as an ordinary one and hand the body
        // a message an app is saying through his earphones. The newest id is kept unseen until then.
        if isRegistered, let latest = presence.reachOut?.latestId, latest != lastReachOutID {
            lastReachOutID = latest
            enqueue { await self.readReachOuts() }
        }
        Task { await registerIfNeeded() }
    }

    // MARK: Her own messages

    /// Something of hers (a call, dictation, another line) or the owner's call holds the sound: the bubble only.
    var soundTaken: Bool {
        (voiceCall?.holdsMicrophone ?? false) || (voiceCall?.dictationHoldsMicrophone ?? false) || ownerInCallElsewhere
            || ShannonSpeechArbiter.shared.isBusyForTouchLine
    }

    /// Reads her messages as her body (an app that says one through his earphones keeps it) and shows the new ones.
    /// Reading never marks them read: that belongs to the apps.
    func readReachOuts() async {
        guard let client, let conversation, isShown, isRegistered,
              let inbox = try? await client.bodyInitiatives(scopeKey: conversation.scopeKey) else { return }
        var shown = UserDefaults.standard.stringArray(forKey: Self.shownReachOutsKey) ?? []
        let fresh = inbox.messages.filter { $0.kind == "reach_out" && !shown.contains($0.id) }
            .sorted { $0.createdAt < $1.createdAt }
        guard !fresh.isEmpty else { return }
        shown = Array((shown + fresh.map(\.id)).suffix(200))
        UserDefaults.standard.set(shown, forKey: Self.shownReachOutsKey)
        for message in fresh { await deliver(message) }
    }

    private func deliver(_ message: ShannonInitiativeMessageDTO) async {
        let plan = ShannonDesktopBodyReachOut.plan(
            speaks: speaks, windowShown: isShown, ownerAway: away.isAway,
            createdAt: ShannonBodySignals.date(message.createdAt), now: Date(), soundTaken: soundTaken)
        switch plan {
        case .skip:
            return
        case let .notShown(outcome):
            await reportDelivery(message.id, outcome)
        case .showSilently:
            Task { await self.reportDelivery(message.id, "shown") }
            await say(message.content, id: message.id, expression: message.expression.rawValue, speak: false)
        case .speak:
            let heard = await say(message.content, id: message.id, expression: message.expression.rawValue, speak: true)
            await reportDelivery(message.id, ShannonDesktopBodyReachOut.outcome(heard: heard))
        }
    }

    private func reportDelivery(_ id: String, _ outcome: String) async {
        guard let client, let conversation, mayBeHeard, isRegistered else { return }
        try? await client.reportReachOut(scopeKey: conversation.scopeKey, id: id, outcome: outcome)
    }

    /// Her lines are said one after another, never over each other, and never hold up the reading of presence.
    func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = speechQueue
        speechQueue = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    // MARK: Who is at the Mac, and the lines of a moment

    /// Every five seconds while her window is up: away / back from idle time and the screen lock; every minute, the
    /// line of a moment that is due.
    private func runMac() async {
        var seconds = 0
        while !Task.isCancelled, isShown {
            observeMac()
            if seconds % 60 == 0, let scene = nudgeClock.dueScene(now: Date(), present: away.isPresent) {
                enqueue { await self.sayNudge(scene) }
            }
            if (voiceCall?.isShown ?? false) || (conversation?.isSending ?? false) { nudgeClock.noteConversation(at: Date()) }
            try? await Task.sleep(for: .seconds(5))
            seconds += 5
        }
    }

    func observeMac() {
        guard let change = away.observe(idleSeconds: macState.idleSeconds, locked: macState.isLocked, now: Date()) else { return }
        let stage = ShannonLive2DStage.shared
        // Away, she rests (the page stops drawing); back, she wakes before she greets him.
        updateSeen()
        switch change {
        case let .away(minutes):
            // She dozes while he is away, and wakes when he is back (as the Windows body does).
            stage.express("sleepy", seconds: 3_600)
            report(plain: "ownerAway", minutesAway: minutes)
        case let .returned(minutes):
            stage.express("joyful", seconds: 4)
            stage.play("wave")
            report(plain: "ownerReturned", minutesAway: minutes)
            enqueue {
                try? await Task.sleep(for: .seconds(4))
                await self.sayNudge("ownerReturned")
            }
        }
    }

    /// A fact for `POST /v1/body/events`, only while 「体に起きたことをシャノンに伝える」 is on.
    func report(plain type: String, minutesAway: Int? = nil) {
        guard ShannonBodyPreference.reportsTouch(), mayBeHeard, let client, let conversation else { return }
        let event = ShannonDesktopBodyEventDTO(
            id: "\(type)-\(UUID().uuidString.lowercased())", type: type, audience: audience,
            occurredAt: Self.timestamp(Date()), minutesAway: minutesAway)
        let scopeKey = conversation.scopeKey
        Task { try? await client.sendBodyEvents(scopeKey: scopeKey, events: [event]) }
    }

    /// A line of a moment (`GET /v1/body/nudges`): the server's fixed words, said by the body at the moment it found.
    /// Not a conversation turn and not an event.
    func sayNudge(_ scene: String) async {
        let now = Date()
        guard speaks, mayBeHeard, away.isPresent, line == nil, !soundTaken, nudgeClock.allows(now: now),
              let client, let conversation,
              let answer = try? await client.bodyNudges(scopeKey: conversation.scopeKey) else { return }
        if let quiet = answer.quietUntil.flatMap(ShannonBodySignals.date), quiet > now { return }
        let alone = audience == .owner
        guard let nudge = answer.nudges.first(where: { $0.scene == scene && ($0.audience == "any" || alone) }),
              !soundTaken, line == nil else { return }
        nudgeClock.noteShown(scene: scene, at: now)
        if scene == "ownerReturned" || scene == "morning" { ShannonLive2DStage.shared.play("wave") }
        await say(nudge.text, id: nudge.id, expression: nudge.expression, feeling: nudge.feeling, speak: true)
    }
}
#endif
