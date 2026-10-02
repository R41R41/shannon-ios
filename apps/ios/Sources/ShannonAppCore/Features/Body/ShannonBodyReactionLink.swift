import Foundation

/// Carries the id of a touch reaction to the voice turn that answers it (`docs/body-contract.md`,
/// "If he answers"): the first utterance of the call that listened names it on its delegation, and the
/// stored turn names it once, so the Talk reads her line → his words → her reply.
///
/// The id belongs to one utterance: a retry or a fallback of the same delegation carries it again, any
/// other utterance does not. It is dropped when the call ends, so a later call never gets it, and a
/// turn other people can hear never carries it.
public final class ShannonBodyReactionLink: @unchecked Sendable {
    public static let shared = ShannonBodyReactionLink()
    /// The server takes the first voice turn up to `listenSeconds` plus this after her line.
    static let marginSeconds: TimeInterval = 60
    /// Once a delegation named it, the stored turn may follow within this (the server's own window).
    static let turnSeconds: TimeInterval = 10 * 60

    private let lock = NSLock()
    private var reactionID: String?
    private var until = Date.distantPast
    private var utterance: String?
    private var delegatedAt: Date?

    public init() {}

    public func arm(reactionID: String, listenSeconds: Int, now: Date = Date()) {
        lock.lock()
        self.reactionID = reactionID
        until = now.addingTimeInterval(TimeInterval(max(0, listenSeconds)) + Self.marginSeconds)
        utterance = nil
        delegatedAt = nil
        lock.unlock()
    }

    public func disarm() {
        lock.lock()
        reactionID = nil
        utterance = nil
        delegatedAt = nil
        lock.unlock()
    }

    /// For the delegation of the first owner utterance inside the window, and for a repeat of that same utterance.
    public func forDelegation(ownerMode: Bool, utterance words: String, now: Date = Date()) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard ownerMode, let reactionID else { return nil }
        if let utterance { return utterance == words ? reactionID : nil }
        guard now <= until else { return nil }
        utterance = words
        delegatedAt = now
        return reactionID
    }

    /// For the stored turn of that delegation, once. With someone else listening, or too late for the server, it is stored without it.
    public func forTurn(companionPresent: Bool, now: Date = Date()) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let delegatedAt, let reactionID else { return nil }
        self.reactionID = nil
        utterance = nil
        self.delegatedAt = nil
        return companionPresent || now.timeIntervalSince(delegatedAt) > Self.turnSeconds ? nil : reactionID
    }
}

extension ShannonLiveVoiceDelegationRequestDTO {
    /// The same request, naming the touch reaction it answers when it is the first utterance after one.
    func linkedToReaction(_ link: ShannonBodyReactionLink = .shared) -> Self {
        var linked = self
        linked.reactionId = link.forDelegation(ownerMode: participantMode == .owner, utterance: transcript)
        return linked
    }
}

extension ShannonRealtimeVoiceTurnRequestDTO {
    func linkedToReaction(_ link: ShannonBodyReactionLink = .shared) -> Self {
        var linked = self
        linked.reactionId = link.forTurn(companionPresent: companionPresent == true)
        return linked
    }
}
