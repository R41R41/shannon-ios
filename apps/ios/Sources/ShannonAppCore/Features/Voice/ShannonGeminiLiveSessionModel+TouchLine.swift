import Foundation

/// Her line for a touch during a voice conversation (owner, 2026-10-14: 「iphoneではシャノンと音声会話中に触っても反応がない」;
/// `docs/body-contract.md`, "A body that only feels touch"). The line is hers, from the touch's reaction request; the call
/// only says it, in its own voice, as her next words: like a sentence of a reply the echo guard knows it and his words cut
/// it, and it is never stored as a turn here (his next utterance names the reaction, so the Talk reads her line, his words,
/// her reply).
extension ShannonGeminiLiveSessionModel {
    /// Whether her line could be said in this call now: an owner call that is listening, nobody else around, no reply of
    /// hers under way, and no words of his being heard, assembled or waiting for her reply.
    var mayHearTouchLine: Bool {
        phase == .listening && participantMode == .owner && !companionSuspected && transport != nil && streamSpeech != nil
            && responseTask == nil && pendingTurns.turns.isEmpty && !turnAssembler.hasFinalText
            && !speechSegments.hearsSpeech(at: ProcessInfo.processInfo.systemUptime) && audioLevel <= Self.answerSoundLevel
    }

    /// Says her line in the call. True when any of it was scheduled to sound. Asked once more here, after the reaction's
    /// round trip: if he began to speak or a reply began meanwhile, nothing is said (the bubble stays).
    func sayTouchLine(_ text: String) async -> Bool {
        guard mayHearTouchLine, let streamSpeech else { return false }
        let generation = UUID()
        responseGenerationID = generation
        responseDelivery = ShannonVoiceResponseDelivery()
        let before = outputAudioSeconds
        let provider = speechProvider
        ShannonVoiceDiagnostics.shared.record("body.touch.line.call.started", sessionID: generation.uuidString)
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let style = provider == .gemini
                    ? ShannonGeminiCascadeSpeech.style(for: text, plan: nil) : ShannonElevenCascadeSpeech.style(for: text, plan: nil)
                let speech = try await streamSpeech(text, style)
                try await consumeResponseSpeech(speech, text: text, generation: generation, runID: generation)
                try await transport?.waitForPlayback()
            } catch {
                // His words cut it (`interruptResponse` has already made the call his), or the call ended.
                guard responseGenerationID == generation, !Task.isCancelled else { return }
                transport?.discardPlayback()
            }
            guard responseGenerationID == generation else { return }
            finishTouchLine()
        }
        responseTask = task
        await task.value
        let sounded = outputAudioSeconds > before
        ShannonVoiceDiagnostics.shared.record("body.touch.line.call.finished", sessionID: generation.uuidString,
            metadata: ["sounded": String(sounded)])
        return sounded
    }

    /// As at the end of a reply: the call listens again, and words of his that came meanwhile are answered.
    private func finishTouchLine() {
        responseTask = nil
        responseGenerationID = nil
        markPlaybackEnded()
        playbackLevel = 0
        phase = .listening
        if !pendingTurns.turns.isEmpty, transport != nil { beginResponse() }
    }
}
