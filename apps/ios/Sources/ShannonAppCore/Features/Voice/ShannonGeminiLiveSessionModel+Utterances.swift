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

    /// `beginsResponse`: false when the caller is about to interrupt and answer anyway (an ownership flip).
    func finalizeTranscript(turnComplete: Bool, beginsResponse: Bool = true) {
        finalizeTask?.cancel()
        finalizeTask = nil
        guard let envelope = turnAssembler.finish() else { return }
        ShannonVoiceTurnDiagnostics.recordAssembled(envelope, turnComplete: turnComplete)
        appendUtterance(id: envelope.id, rawText: envelope.rawText, text: envelope.normalizedText,
            source: .speech, addressedByName: envelope.addressee == "shannon",
            followsShannonTurn: heardRightAfterShannon, ownersWords: bufferIsOwners)
        bufferIsOwners = false
        userTranscript = pendingTurns.displayText
        if beginsResponse { beginResponse() }
    }

    /// Decides whose words a transcript arriving now are. In 「友人も一緒」 they are the owner's when their speech
    /// segment began before the switch (however late the recogniser delivers them, every chunk until that segment
    /// ended); only when the call reports no onsets does the arrival window after the switch decide
    /// (`recogniserLag`). Words of the other side already being assembled are finished first, so the buffer never
    /// mixes the two.
    /// A new session or the end of the call: nothing of the last call's speech or ownership carries over.
    func resetSpeechOwnership() {
        // Words still being assembled when a call ends belong to that call.
        turnAssembler.reset()
        heardRightAfterShannon = false
        speechSegments.reset()
        bufferIsOwners = false
        switchedToGuestAt = nil
        ownerWordsReceivedUntil = nil
    }

    func takeOwnership(of claim: ShannonVoiceSpeechSegments.Claim, at now: TimeInterval) {
        // Logged only within the 「友人も一緒」 period the switch began.
        if participantMode == .guest, let switchedAt = switchedToGuestAt {
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
        // The words of the other side become their own turn; the reply waits for this transcript (no begin-then-cut).
        if turnAssembler.hasFinalText, owners != bufferIsOwners { finalizeTranscript(turnComplete: true, beginsResponse: false) }
        bufferIsOwners = owners
    }
}
