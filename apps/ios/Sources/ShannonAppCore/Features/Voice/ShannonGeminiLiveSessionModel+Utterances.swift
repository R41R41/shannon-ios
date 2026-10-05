import Foundation

/// The speech segments the recogniser reports (`.speechStarted` … `.speechStopped`) and the transcripts that
/// follow them, in order. A switch into 「友人も一緒」 marks every segment that began before it as the owner's: its
/// transcript is his however late it arrives, and so is every chunk of it until the segment has ended.
struct ShannonVoiceSpeechSegments: Equatable, Sendable {
    struct Segment: Equatable, Sendable {
        var owners = false
        var open = true
        var stoppedAt: TimeInterval?
        var transcribed = false
    }

    /// A segment that ended and never brought a transcript (noise, a cough) is forgotten after this long, as the
    /// barge-in rule forgets where an utterance began (`ShannonVoiceBargeInRule.originSeconds`).
    static let untranscribedMemory: TimeInterval = ShannonVoiceBargeInRule.originSeconds
    static let retained = 8

    private(set) var segments: [Segment] = []
    /// Whether this call has reported speech onsets at all; without them the decision falls back to arrival time.
    private(set) var knowsOnsets = false

    mutating func started(at now: TimeInterval) {
        knowsOnsets = true
        segments.append(Segment())
        if segments.count > Self.retained { segments.removeFirst(segments.count - Self.retained) }
    }

    mutating func stopped(at now: TimeInterval) {
        guard let index = segments.lastIndex(where: \.open) else { return }
        segments[index].open = false
        segments[index].stoppedAt = now
    }

    /// The switch: every segment that began before it is the owner's.
    mutating func switchedToGuest() {
        for index in segments.indices { segments[index].owners = true }
    }

    /// Takes the segment a transcript arriving now belongs to and says whether it is the owner's; nil when the
    /// call reports no onsets. The oldest segment that ended without its transcript comes first; else the one
    /// still open (a chunk of it); else the last (a late chunk).
    mutating func claimTranscript(at now: TimeInterval) -> Bool? {
        guard knowsOnsets else { return nil }
        segments.removeAll { !$0.open && !$0.transcribed && now - ($0.stoppedAt ?? now) > Self.untranscribedMemory }
        guard !segments.isEmpty else { return false }
        let index = segments.firstIndex { !$0.open && !$0.transcribed }
            ?? segments.lastIndex(where: \.open)
            ?? segments.count - 1
        segments[index].transcribed = true
        let owners = segments[index].owners
        // Settled segments before it are done with.
        if index > 0 { segments.removeFirst(index) }
        return owners
    }

    mutating func reset() {
        segments = []
        knowsOnsets = false
    }
}

/// Turning transcripts into utterances: the preview, the pause before an utterance is finished, and whose it is.
extension ShannonGeminiLiveSessionModel {
    func previewInput(_ current: String) -> String {
[pendingTurns.displayText, bufferIsOwners ? "" : current].filter { !$0.isEmpty }.joined(separator: "\n")
    }

    func scheduleFinalization(turnComplete: Bool) {
        guard turnAssembler.hasFinalText else { return }
        finalizeTask?.cancel()
        let delay = turnAssembler.finalizationDelayMilliseconds(turnComplete: turnComplete)
        ShannonVoiceTurnDiagnostics.recordFinalizationScheduled(delay: delay, turnComplete: turnComplete)
        finalizeTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
            self?.finalizeTranscript(turnComplete: turnComplete)
        }
    }

    func finalizeTranscript(turnComplete: Bool) {
        finalizeTask?.cancel()
        finalizeTask = nil
        guard let envelope = turnAssembler.finish() else { return }
        ShannonVoiceTurnDiagnostics.recordAssembled(envelope, turnComplete: turnComplete)
        appendUtterance(id: envelope.id, rawText: envelope.rawText, text: envelope.normalizedText,
            source: .speech, addressedByName: envelope.addressee == "shannon",
            followsShannonTurn: heardRightAfterShannon, ownersWords: bufferIsOwners)
        bufferIsOwners = false
        userTranscript = pendingTurns.displayText
        beginResponse()
    }

    /// Decides whose words a transcript arriving now are. In 「友人も一緒」 they are the owner's when their speech
    /// segment began before the switch (however late the recogniser delivers them, every chunk until that segment
    /// ended); only when the call reports no onsets does the arrival window after the switch decide
    /// (`recogniserLag`). Words of the other side already being assembled are finished first, so the buffer never
    /// mixes the two.
    func takeOwnership(segmentIsOwners claimed: Bool?, at now: TimeInterval) {
        if let switchedAt = switchedToGuestAt {
            // How long the first words took to arrive after the switch: the delay alone, no content.
            ShannonVoiceDiagnostics.shared.record("gemini.participant.first_words_after_switch",
                metadata: ["delay_ms": String(Int(max(0, now - switchedAt) * 1_000))])
            switchedToGuestAt = nil
        }
        guard participantMode == .guest else { return }
        let owners = claimed ?? isOwnersWords(startedAt: Date())
        if turnAssembler.hasFinalText, owners != bufferIsOwners { finalizeTranscript(turnComplete: true) }
        bufferIsOwners = owners
    }
}
