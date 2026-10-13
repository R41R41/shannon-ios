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
        var startedAt: TimeInterval?
    }

    /// What a transcript arriving now is.
    enum Claim: Equatable, Sendable {
        /// Speech that began before the switch into 「友人も一緒」.
        case owners
        /// Speech of the 「友人も一緒」 period, or of 本人だけ.
        case others
        /// Nothing tells (no id, no onsets): the arrival window after a switch decides (`recogniserLag`).
        case unknown
        /// An id this call never saw begin. In 「友人も一緒」 it counts as the owner's, never the guests'.
        case unrecognised
        /// Its segment was discarded (a switch back to 本人だけ): heard in 「友人も一緒」, it is never answered now.
        case stale
    }

    /// A segment of the guests' (or of 本人だけ) that ended and never brought a transcript (noise, a cough) is
    /// forgotten after this long, as the barge-in rule forgets where an utterance began. The owner's segments are
    /// never forgotten before their transcript arrives or the call ends.
    static let untranscribedMemory: TimeInterval = ShannonVoiceBargeInRule.originSeconds
    /// At most this many segments of others are kept; the owner's are not counted against it.
    static let retained = 8
    static let discardedMemory = 32

    private(set) var segments: [Segment] = []
    /// Whether this call has reported speech onsets at all; without them the decision falls back to arrival time.
    private(set) var knowsOnsets = false
    /// Ids of segments discarded by a switch back to 本人だけ.
    private(set) var discardedIDs: [String] = []
    /// Ids of segments forgotten by age or count before their words came. A transcript of one of them is the
    /// owner's (the privacy direction: it may have begun before a switch).
    private(set) var prunedIDs: [String] = []
    /// A transcript without an id was matched by order (logged once).
    private(set) var usedOrderFallback = false

    mutating func started(itemID: String?, at now: TimeInterval) {
        knowsOnsets = true
        segments.append(Segment(itemID: itemID, startedAt: now))
        prune(at: now)
    }

    /// Someone is speaking now: a segment began less than `recent` seconds ago and has not stopped (an onset whose end
    /// never came stops counting after that, so a lost event cannot hold her quiet for the rest of the call).
    func hearsSpeech(at now: TimeInterval, recent: TimeInterval = 20) -> Bool {
        segments.contains { $0.open && now - ($0.startedAt ?? -.infinity) < recent }
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
    /// oldest segment that ended without its transcript, else the one still open). With no segment to take, nothing
    /// is known: never 「the guests'」 by default, the arrival window decides.
    mutating func claimTranscript(itemID: String?, at now: TimeInterval) -> Claim {
        prune(at: now)
        if let itemID {
            if let index = segments.firstIndex(where: { $0.itemID == itemID }) { return take(index) }
            if discardedIDs.contains(itemID) { return .stale }
            if prunedIDs.contains(itemID) { return .owners }
            return .unrecognised
        }
        guard knowsOnsets, !segments.isEmpty else { return .unknown }
        if !usedOrderFallback {
            usedOrderFallback = true
            ShannonVoiceDiagnostics.shared.record("gemini.input.segment.order_fallback")
        }
        guard let index = segments.firstIndex(where: { !$0.open && !$0.transcribed })
            ?? segments.lastIndex(where: \.open) else { return .unknown }
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
        // Settled segments are done with (an open one may still bring more words, matched by order).
        segments.removeAll { $0.transcribed && !$0.open }
        return claim
    }

    private mutating func prune(at now: TimeInterval) {
        let expired = segments.filter {
            !$0.owners && !$0.open && !$0.transcribed && now - ($0.stoppedAt ?? now) > Self.untranscribedMemory
        }
        remember(pruned: expired)
        segments.removeAll {
            !$0.owners && !$0.open && !$0.transcribed && now - ($0.stoppedAt ?? now) > Self.untranscribedMemory
        }
        while segments.filter({ !$0.owners }).count > Self.retained,
              let oldest = segments.firstIndex(where: { !$0.owners }) {
            remember(pruned: [segments[oldest]])
            segments.remove(at: oldest)
        }
    }

    private mutating func remember(pruned: [Segment]) {
        prunedIDs.append(contentsOf: pruned.filter { !$0.transcribed }.compactMap(\.itemID))
        if prunedIDs.count > Self.discardedMemory { prunedIDs.removeFirst(prunedIDs.count - Self.discardedMemory) }
    }
}
