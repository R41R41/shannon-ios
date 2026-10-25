import Foundation
import Observation

/// How saying one message ended.
public enum ShannonReachOutSpeechOutcome: Equatable, Sendable {
    /// All of it was played.
    case spoken
    /// It began, and was stopped because the sound was no longer only for the owner.
    case cutShort
    /// Nothing was played: the sound was no longer private when it was about to start.
    case notStarted
    /// Her voice could not be produced or played.
    case failed
}

/// Says a line in Shannon's voice through the current output.
@MainActor
public protocol ShannonReachOutSpeaking: AnyObject {
    /// `stillPrivate` is asked before the first sound and at every change of the route; a no stops the sound at once.
    func speak(_ text: String, stillPrivate: @escaping @MainActor () -> Bool) async -> ShannonReachOutSpeechOutcome
    func stop()
}

/// Opens the microphone for the owner's answer after she spoke. An answer becomes a conversation that is
/// stored as conversations are; silence stores nothing.
@MainActor
public protocol ShannonReachOutListening: AnyObject {
    func listen(for seconds: Int, after message: ShannonPrivateReachOutMessageDTO) async
}

/// What the settings show about the last message she said through the earphones.
public enum ShannonPrivateReachOutActivity: Equatable, Sendable {
    case idle
    case speaking
    case listening
}

/// Says a message Shannon started on her own through the owner's earphones (owner decision 2026-10-02).
///
/// The server offers the message to one app only. Before a word is said this app takes the message's
/// claim, so no other surface says it, and asks again whether only the owner can hear. If that is no
/// longer so, nothing is said, the claim is given back, and the message stays what it already is: text
/// in the Talk. After speaking, the microphone opens for a few seconds.
@MainActor
@Observable
public final class ShannonPrivateReachOutCoordinator {
    public private(set) var activity: ShannonPrivateReachOutActivity = .idle

    @ObservationIgnored private let client: (any ShannonPrivateListeningServing)?
    @ObservationIgnored private let defaults: UserDefaults
    /// Asked right before speaking and while speaking: is the sound still only for the owner?
    @ObservationIgnored public var stillPrivate: @MainActor () -> Bool = { false }
    /// A conversation is going on in this app (a voice call, dictation, a message being sent): she does not speak into it.
    @ObservationIgnored public var isConversationActive: @MainActor () -> Bool = { false }
    @ObservationIgnored public var speaker: (any ShannonReachOutSpeaking)?
    @ObservationIgnored public var listener: (any ShannonReachOutListening)?
    /// Runs the whole delivery; the iPhone app wraps it in a background task so it is not suspended half-way.
    @ObservationIgnored public var protect: @MainActor (@escaping @MainActor () async -> Void) async -> Void = { await $0() }
    @ObservationIgnored private var isBusy = false
    @ObservationIgnored private var isFlushing = false

    public static let handledDefaultsKey = "shannon.privateListening.handledReachOuts"
    public static let outcomesDefaultsKey = "shannon.privateListening.reachOutOutcomes"
    public static let unacknowledgedDefaultsKey = "shannon.privateListening.unacknowledgedReachOuts"
    static let maximumHandled = 50
    /// Answers after which the same report would be refused again: malformed, not this device's, unknown, already settled, too old.
    static let finalStatuses: Set<Int> = [400, 401, 403, 404, 409, 410]

    public init(client: (any ShannonPrivateListeningServing)?, defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
    }

    /// Ids this device already took once. A message is never said twice by the same device, also across launches.
    var handled: [String] { defaults.stringArray(forKey: Self.handledDefaultsKey) ?? [] }

    private func remember(_ id: String) {
        var ids = handled.filter { $0 != id }
        ids.append(id)
        ids = Array(ids.suffix(Self.maximumHandled))
        defaults.set(ids, forKey: Self.handledDefaultsKey)
        defaults.set(outcomes.filter { ids.contains($0.key) }, forKey: Self.outcomesDefaultsKey)
    }

    /// What this device did with the messages it took.
    private var outcomes: [String: String] { defaults.dictionary(forKey: Self.outcomesDefaultsKey) as? [String: String] ?? [:] }

    /// Reports the server has not acknowledged yet. Kept on the device, so they also survive the app being closed.
    var unacknowledged: [String] { defaults.stringArray(forKey: Self.unacknowledgedDefaultsKey) ?? [] }

    /// Records what was done with a message. The report is sent by `flushReports`, now and with every later heartbeat,
    /// until the server has taken it: a message that was said must never look unsaid to the other surfaces.
    private func settle(_ id: String, _ outcome: ShannonPrivateReachOutOutcome) {
        var known = outcomes
        known[id] = outcome.rawValue
        defaults.set(known, forKey: Self.outcomesDefaultsKey)
        defaults.set(Array((unacknowledged.filter { $0 != id } + [id]).suffix(Self.maximumHandled)), forKey: Self.unacknowledgedDefaultsKey)
    }

    /// Sends every report the server has not acknowledged. A report is done once the server answered: accepted, or
    /// refused for good (it holds no such claim any more). A request that did not get through stays for the next time.
    public func flushReports() async {
        guard let client, !isFlushing, !unacknowledged.isEmpty else { return }
        isFlushing = true
        defer { isFlushing = false }
        for id in unacknowledged {
            // A message whose fate is unknown (the app stopped half-way) counts as spoken, so nobody says it a second time.
            let outcome = outcomes[id].flatMap(ShannonPrivateReachOutOutcome.init(rawValue:)) ?? .spoken
            do {
                try await client.reportPrivateReachOut(id: id, outcome: outcome)
            } catch let error as ShannonAPIError {
                // Only an answer that says "never" ends it. A server that is restarting or busy is asked again.
                guard case let .rejected(status) = error, Self.finalStatuses.contains(status) else { continue }
            } catch {
                continue
            }
            defaults.set(unacknowledged.filter { $0 != id }, forKey: Self.unacknowledgedDefaultsKey)
        }
    }

    /// The server offers a message this device took before: its earlier report did not arrive, or the app stopped
    /// half-way. It is not said again; what was done is reported again.
    private func reportAgain(_ id: String) async {
        if !unacknowledged.contains(id) {
            defaults.set(Array((unacknowledged + [id]).suffix(Self.maximumHandled)), forKey: Self.unacknowledgedDefaultsKey)
        }
        await flushReports()
    }

    /// The owner switched speaking off, or the app is closing: whatever is being said stops.
    public func stopSpeaking() {
        speaker?.stop()
    }

    /// The server offered a message. Returns when it was said, given back, or left alone.
    public func handle(_ offer: ShannonPrivateReachOutOfferDTO) async {
        guard !isBusy, let client, let speaker else { return }
        isBusy = true
        defer {
            isBusy = false
            activity = .idle
        }
        guard !handled.contains(offer.id) else {
            await reportAgain(offer.id)
            return
        }
        guard stillPrivate(), !isConversationActive() else { return }
        await protect { [self] in
            await deliver(offer, client: client, speaker: speaker)
        }
    }

    private func deliver(
        _ offer: ShannonPrivateReachOutOfferDTO, client: any ShannonPrivateListeningServing, speaker: any ShannonReachOutSpeaking
    ) async {
        let claim: ShannonPrivateReachOutClaimDTO
        do {
            claim = try await client.claimPrivateReachOut(id: offer.id)
        } catch {
            // Another surface has it, the owner already answered or read it, or the server could not be reached:
            // in every case this app says nothing.
            return
        }
        // From here the message is this device's. It is remembered first, so a crash cannot make it be said twice.
        remember(offer.id)
        guard !claim.spoken else { return }
        // Between the claim and the first sound the earphones may have gone, a friend may have joined, or he may have started talking.
        guard stillPrivate(), !isConversationActive() else {
            settle(offer.id, .notSpoken)
            await flushReports()
            return
        }
        activity = .speaking
        let outcome = await speaker.speak(claim.message.content) { [weak self] in
            self?.stillPrivate() ?? false
        }
        switch outcome {
        case .notStarted, .failed:
            // Nothing was heard: the message goes back, and stays text in the Talk.
            settle(offer.id, .notSpoken)
            await flushReports()
        case .cutShort:
            // He heard part of it. It is not said again by anyone, and nothing listens on an output that is not private.
            settle(offer.id, .spoken)
            await flushReports()
        case .spoken:
            settle(offer.id, .spoken)
            // The report goes out beside the microphone, not before it: his answer must not wait for the network.
            let reporting = Task { @MainActor [weak self] in await self?.flushReports() }
            // 「耳: 聞かない」 (`ShannonVoiceEar`): she said it, and does not open the microphone for his answer.
            if claim.listenSeconds > 0, let listener, ShannonVoiceEar.listens(defaults), stillPrivate(), !isConversationActive() {
                activity = .listening
                await listener.listen(for: claim.listenSeconds, after: claim.message)
            }
            await reporting.value
        }
    }
}
