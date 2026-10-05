import Foundation

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
    func takeOwnership(of claim: ShannonVoiceSpeechSegments.Claim, at now: TimeInterval) {
        if let switchedAt = switchedToGuestAt {
            // How long the first words took to arrive after the switch: the delay alone, no content.
            ShannonVoiceDiagnostics.shared.record("gemini.participant.first_words_after_switch",
                metadata: ["delay_ms": String(Int(max(0, now - switchedAt) * 1_000))])
            switchedToGuestAt = nil
        }
        guard participantMode == .guest else { return }
        let owners = switch claim {
        case .owners: true
        case .others: false
        case .unknown, .stale: isOwnersWords(startedAt: Date())
        }
        if turnAssembler.hasFinalText, owners != bufferIsOwners { finalizeTranscript(turnComplete: true) }
        bufferIsOwners = owners
    }
}
