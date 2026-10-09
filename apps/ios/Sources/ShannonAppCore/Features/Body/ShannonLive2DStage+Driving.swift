import Foundation
import WebKit

/// What the app tells her figure: the calls into `window.shannonBody`.
extension ShannonLive2DStage {

    public func express(_ expression: String, feeling: String? = nil, seconds: Double? = nil) {
        mirror(.express(expression: expression, feeling: feeling, seconds: seconds))
        noteActivity()
        send(.express(expression: expression, feeling: feeling, seconds: seconds))
    }

    public func expressEmotion(_ name: String, intensity: Double) {
        mirror(.expressEmotion(name: name, intensity: intensity))
        noteActivity()
        send(.expressEmotion(name: name, intensity: intensity))
    }

    public func setMood(valence: Double, arousal: Double, openness: Double) {
        mood = (valence, arousal, openness)
        mirror(.setMood(valence: valence, arousal: arousal, openness: openness))
        send(.setMood(valence: valence, arousal: arousal, openness: openness))
    }

    public func setPresence(_ value: ShannonLive2DPresence) {
        mirror(.setPresence(value))
        guard presence != value else { return }
        // More stories waiting makes her fidget: that is worth waking a resting figure for.
        if value.awaitingReaction > (presence?.awaitingReaction ?? 0) { noteActivity() }
        presence = value
        send(.setPresence(value))
    }

    public func setPhase(_ value: ShannonLive2DPhase) {
        mirror(.setPhase(value))
        guard phase != value else { return }
        phase = value
        noteActivity()
        send(.setPhase(value))
        if value != .speaking { lastMouthLevel = 0 }
    }

    /// The level of the audio being played, 0–1. Zero when speech ends. Her eyes alone have no mouth: nothing is sent.
    public func setMouthLevel(_ level: Double) {
        let clamped = min(1, max(0, level.isFinite ? level : 0))
        mirror(.setMouthLevel(clamped))
        guard status == .ready, sentPaused == false || clamped <= 0,
              ShannonLive2DStagePolicy.sendsMouthLevel(clamped, last: lastMouthLevel, body: body) else { return }
        lastMouthLevel = clamped
        if clamped > 0 { lastActivityAt = Date() }
        send(.setMouthLevel(clamped))
    }

    /// A gesture of the character. Her eyes alone have no arms: nothing is sent.
    public func play(_ gesture: String) {
        mirror(.play(gesture))
        guard ShannonLive2DStagePolicy.playsGesture(gesture, known: gestures, body: body) else { return }
        noteActivity()
        send(.play(gesture))
    }

    /// True acknowledges one invocation in this renderer, not that the animation finished.
    /// Mirrors are intentionally excluded: a touch belongs to this device's physical surface.
    func invokeTouchGesture(_ gesture: String) async -> Bool? {
        guard let webView, status == .ready, ShannonLive2DStagePolicy.playsGesture(gesture, known: gestures, body: body) else { return false }
        noteActivity()
        let script = "(() => { if (!window.shannonBody || typeof window.shannonBody.play !== 'function') return false; \(ShannonLive2DCommand.play(gesture).javaScript); return true; })()"
        return await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                continuation.resume(returning: error == nil ? value as? Bool : nil)
            }
        }
    }

    /// Frames per second, reported every five seconds while a diagnostics view asks for it.
    public func setFrameStats(_ enabled: Bool) {
        frameStats = enabled
        if !enabled { framesPerSecond = nil }
        send(.setFrameStats(enabled))
    }
}
