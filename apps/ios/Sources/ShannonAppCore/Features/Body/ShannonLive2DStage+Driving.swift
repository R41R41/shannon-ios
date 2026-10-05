import Foundation

/// What the app tells her figure: the calls into `window.shannonBody`.
extension ShannonLive2DStage {

    public func express(_ expression: String, feeling: String? = nil, seconds: Double? = nil) {
        noteActivity()
        send(.express(expression: expression, feeling: feeling, seconds: seconds))
    }

    public func expressEmotion(_ name: String, intensity: Double) {
        noteActivity()
        send(.expressEmotion(name: name, intensity: intensity))
    }

    public func setMood(valence: Double, arousal: Double, openness: Double) {
        mood = (valence, arousal, openness)
        send(.setMood(valence: valence, arousal: arousal, openness: openness))
    }

    public func setPresence(_ value: ShannonLive2DPresence) {
        guard presence != value else { return }
        // More stories waiting makes her fidget: that is worth waking a resting figure for.
        if value.awaitingReaction > (presence?.awaitingReaction ?? 0) { noteActivity() }
        presence = value
        send(.setPresence(value))
    }

    public func setPhase(_ value: ShannonLive2DPhase) {
        guard phase != value else { return }
        phase = value
        noteActivity()
        send(.setPhase(value))
        if value != .speaking { lastMouthLevel = 0 }
    }

    /// The level of the audio being played, 0–1. Zero when speech ends. Her eyes alone have no mouth: nothing is sent.
    public func setMouthLevel(_ level: Double) {
        let clamped = min(1, max(0, level.isFinite ? level : 0))
        guard status == .ready, body.hasCharacterRig, sentPaused == false || clamped <= 0,
              ShannonLive2DStagePolicy.sendsMouthLevel(clamped, last: lastMouthLevel) else { return }
        lastMouthLevel = clamped
        if clamped > 0 { lastActivityAt = Date() }
        send(.setMouthLevel(clamped))
    }

    /// A gesture of the character. Her eyes alone have no arms: nothing is sent.
    public func play(_ gesture: String) {
        guard body.hasCharacterRig, gestures.contains(gesture) else { return }
        noteActivity()
        send(.play(gesture))
    }

    /// Frames per second, reported every five seconds while a diagnostics view asks for it.
    public func setFrameStats(_ enabled: Bool) {
        frameStats = enabled
        if !enabled { framesPerSecond = nil }
        send(.setFrameStats(enabled))
    }
}
