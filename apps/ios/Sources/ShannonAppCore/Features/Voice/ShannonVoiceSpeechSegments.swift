import Foundation

/// The speech segments the recogniser reports (`.speechStarted` … `.speechStopped`) and their transcripts. A switch
/// into 「友人も一緒」 marks every segment that began before it as the owner's: its transcript is his however late it
/// arrives. OpenAI's transcription completions are not ordered across turns, so a transcript is matched to its
/// segment by `item_id`; matching by order is only the fallback for events that carry no id (logged once a call).
struct ShannonVoiceSpeechSegments: Equatable, Sendable {
    struct Segment: Equatable, Sendable {
        var itemID: String?
        var owners = false
        var open = true
        var stoppedAt: TimeInterval?
        var transcribed = false
    }

    /// What a transcript arriving now is.
    enum Claim: Equatable, Sendable {
        /// Speech that began before the switch into 「友人も一緒」.
        case owners
        /// Speech of the 「友人も一緒」 period, or of 本人だけ.
        case others
        /// Nothing tells: the arrival window after a switch decides (`recogniserLag`).
        case unknown
        /// Its segment was discarded (a switch back to 本人だけ): heard in 「友人も一緒」, it is never answered now.
        case stale
    }

    /// A segment that ended and never brought a transcript (noise, a cough) is forgotten after this long, as the
    /// barge-in rule forgets where an utterance began.
    static let untranscribedMemory: TimeInterval = ShannonVoiceBargeInRule.originSeconds
    /// At most this many segments are kept.
    static let retained = 8
    static let discardedMemory = 32

    private(set) var segments: [Segment] = []
    /// Whether this call has reported speech onsets at all; without them the decision falls back to arrival time.
    private(set) var knowsOnsets = false
    /// Ids of segments discarded by a switch back to 本人だけ.
    private(set) var discardedIDs: [String] = []
    /// A transcript without an id was matched by order (logged once).
    private(set) var usedOrderFallback = false

    mutating func started(itemID: String?, at now: TimeInterval) {
        knowsOnsets = true
        segments.append(Segment(itemID: itemID))
        prune(at: now)
    }

    mutating func stopped(itemID: String?, at now: TimeInterval) {
        let index = itemID.flatMap { id in segments.lastIndex { $0.itemID == id } } ?? segments.lastIndex(where: \.open)
        guard let index else { return }
        segments[index].open = false
        segments[index].stoppedAt = now
    }

    /// The switch: every segment that began before it is the owner's.
    mutating func switchedToGuest() {
        for index in segments.indices { segments[index].owners = true }
    }

    /// Takes the segment a transcript belongs to: by its id; by order only when the transcript carries none (the
    /// oldest segment that ended without its transcript, else the one still open, else the last).
    mutating func claimTranscript(itemID: String?, at now: TimeInterval) -> Claim {
        prune(at: now)
        if let itemID {
            if let index = segments.firstIndex(where: { $0.itemID == itemID }) { return take(index) }
            if discardedIDs.contains(itemID) { return .stale }
            return .unknown
        }
        guard knowsOnsets, !segments.isEmpty else { return .unknown }
        if !usedOrderFallback {
            usedOrderFallback = true
            ShannonVoiceDiagnostics.shared.record("gemini.input.segment.order_fallback")
        }
        let index = segments.firstIndex { !$0.open && !$0.transcribed }
            ?? segments.lastIndex(where: \.open)
            ?? segments.count - 1
        return take(index)
    }

    /// A switch back to 本人だけ: what was heard until now belongs to the period that ended.
    mutating func discardAll() {
        discardedIDs.append(contentsOf: segments.compactMap(\.itemID))
        if discardedIDs.count > Self.discardedMemory { discardedIDs.removeFirst(discardedIDs.count - Self.discardedMemory) }
        segments = []
    }

    /// The call ended (or a new session began).
    mutating func reset() {
        self = ShannonVoiceSpeechSegments()
    }

    private mutating func take(_ index: Int) -> Claim {
        segments[index].transcribed = true
        let claim: Claim = segments[index].owners ? .owners : .others
        // Settled segments are done with; the last one stays for a late transcript matched by order.
        let last = segments.indices.last
        segments = segments.enumerated().filter { !$0.element.transcribed || $0.offset == last || $0.element.open }.map(\.element)
        return claim
    }

    private mutating func prune(at now: TimeInterval) {
        segments.removeAll { !$0.open && !$0.transcribed && now - ($0.stoppedAt ?? now) > Self.untranscribedMemory }
        if segments.count > Self.retained { segments.removeFirst(segments.count - Self.retained) }
    }
}
