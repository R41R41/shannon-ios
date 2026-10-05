import Foundation

/// Her own voice coming back, and short sounds around it, never cut her off.
extension ShannonGeminiLiveSessionModel {
    /// Whether a finished transcript is dropped: her echo, or a short sound near her voice.
    /// Both rules see every transcript, so neither carries one transcript's origin into the next.
    func discardsNearHerVoice(_ text: String) -> Bool {
        let echo = discardsAsEcho(text)
        let admitted = bargeInRule.admits(text, now: ProcessInfo.processInfo.systemUptime)
        if echo { return true }
        guard !admitted else { return false }
        ShannonVoiceDiagnostics.shared.record("gemini.input.short.ignored",
            metadata: ["characters": String(ShannonSpeechEchoGuard.normalized(text).count)])
        return true
    }

    /// A transcript that repeats what Shannon just said is her own voice through the microphone,
    /// not the owner. Only the character count is logged, never the text.
    private func discardsAsEcho(_ text: String) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        let speaking = responseTask != nil
        guard echoWindow.shouldCompare(text, isSpeaking: speaking, now: now),
              echoGuard.isOwnVoice(text, now: now) else { return false }
        ShannonVoiceDiagnostics.shared.record("gemini.input.echo.discarded",
            metadata: ["characters": String(text.count), "during_playback": String(speaking)])
        return true
    }

    /// One chunk of her voice was played.
    func voicePlaybackProgressed(stillPlaying: Bool) {
        let now = ProcessInfo.processInfo.systemUptime
        echoGuard.markSounding(at: now)
        if stillPlaying { bargeInRule.voiceSounding(at: now) } else { bargeInRule.voiceStopped(at: now) }
    }

    /// Her voice was scheduled to sound now.
    func voiceScheduled() {
        bargeInRule.voiceSounding(at: ProcessInfo.processInfo.systemUptime)
    }

    /// A sentence of hers is remembered when its first audio has played: by the echo guard, and
    /// as said by the response it belongs to.
    func rememberWhenPlayed(_ text: String, generation: UUID) -> @MainActor () -> Void {
        { [weak self] in
            guard let self else { return }
            echoGuard.recordPlayed(text, at: ProcessInfo.processInfo.systemUptime)
            if responseGenerationID == generation { responseDelivery.spoken.played(text) }
        }
    }

    func markPlaybackEnded() {
        let now = ProcessInfo.processInfo.systemUptime
        backgroundSilence.speech(at: Date())
        echoWindow.playbackEnded(at: now)
        bargeInRule.voiceStopped(at: now)
    }
}
