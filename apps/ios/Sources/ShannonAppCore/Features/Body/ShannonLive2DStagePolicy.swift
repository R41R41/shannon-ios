import Foundation

/// The rules of the stage that need no web view, so they can be tested.
enum ShannonLive2DStagePolicy {
    /// The page stops drawing while nobody can see it, while the app is not active, and while it rests.
    static func paused(hasHost: Bool, appActive: Bool, resting: Bool) -> Bool {
        !hasHost || !appActive || resting
    }

    /// With Reduce Motion or Low Power Mode on, an idle figure becomes a still picture after this long.
    static let restAfterSeconds: TimeInterval = 5
    static func rests(calm: Bool, phase: ShannonLive2DPhase, idleSeconds: TimeInterval) -> Bool {
        calm && phase == .idle && idleSeconds >= restAfterSeconds
    }

    /// One automatic reload per minute; a second failure inside it is shown as failed.
    static let reloadSpacingSeconds: TimeInterval = 60
    static func mayReload(lastReloadAt: Date?, now: Date) -> Bool {
        guard let lastReloadAt else { return true }
        return now.timeIntervalSince(lastReloadAt) >= reloadSpacingSeconds
    }

    /// The page is given this long to say `ready`.
    static let loadTimeoutSeconds: TimeInterval = 90
    /// With no screen showing her, the model (about 85 MB of GPU memory) is let go after this long.
    static let releaseAfterSeconds: TimeInterval = 90

    /// A mouth level worth a call: any change of note, and always the return to zero.
    static func sendsMouthLevel(_ level: Double, last: Double) -> Bool {
        level <= 0 ? last > 0 : abs(level - last) >= 0.03
    }
}
