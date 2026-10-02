import Foundation

/// Which screen shows the one figure when several are on screen at once (a cover over the dialogue
/// stage, a sheet over a call). The higher one wins; among equals, the one that appeared last.
public enum ShannonLive2DHostPriority: Int, Comparable, Sendable {
    case hero, dialogue, voice, bodyScreen

    public static func < (left: Self, right: Self) -> Bool { left.rawValue < right.rawValue }
}

/// The rules of the stage that need no web view, so they can be tested.
enum ShannonLive2DStagePolicy {
    /// The page stops drawing while nobody can see it, while the app is not active, and while it rests.
    static func paused(hasHost: Bool, appActive: Bool, resting: Bool) -> Bool {
        !hasHost || !appActive || resting
    }

    /// With Reduce Motion or Low Power Mode on, an idle figure becomes a still picture after this long.
    static let restAfterSeconds: TimeInterval = 5
    static func rests(calm: Bool, phase: ShannonLive2DPhase, idleSeconds: TimeInterval, fingerDown: Bool = false) -> Bool {
        calm && !fingerDown && phase == .idle && idleSeconds >= restAfterSeconds
    }

    /// One automatic reload per minute; a second failure inside it is shown as failed.
    static let reloadSpacingSeconds: TimeInterval = 60
    /// A page that has failed this many times in a row without once saying `ready` is not reloaded again.
    static let failuresWithoutReadyLimit = 2
    static func mayReload(lastReloadAt: Date?, now: Date, failuresWithoutReady: Int = 0) -> Bool {
        guard failuresWithoutReady < failuresWithoutReadyLimit else { return false }
        guard let lastReloadAt else { return true }
        return now.timeIntervalSince(lastReloadAt) >= reloadSpacingSeconds
    }

    /// Where a new host goes among those on screen: above every host of its own or a lower priority,
    /// below the higher ones. The last host of the list shows the figure.
    static func insertionIndex(for priority: ShannonLive2DHostPriority, among priorities: [ShannonLive2DHostPriority]) -> Int {
        (priorities.lastIndex { $0 <= priority }).map { $0 + 1 } ?? 0
    }

    /// The page is given this long to say `ready`, and may not stay silent for longer than the second value
    /// while it loads (it reports its progress; foreground time only).
    static let loadTimeoutSeconds: TimeInterval = 90
    static let loadSilenceSeconds: TimeInterval = 25

    static func loadTimedOut(waited: TimeInterval, silent: TimeInterval) -> Bool {
        waited >= loadTimeoutSeconds || silent >= loadSilenceSeconds
    }

    /// Low Power Mode halves the drawn frames; otherwise the display's own rate.
    static func frameRate(lowPower: Bool) -> Int { lowPower ? 30 : 0 }
    /// With no screen showing her, the model (about 85 MB of GPU memory) is let go after this long.
    static let releaseAfterSeconds: TimeInterval = 90

    /// A mouth level worth a call: any change of note, and always the return to zero.
    static func sendsMouthLevel(_ level: Double, last: Double) -> Bool {
        level <= 0 ? last > 0 : abs(level - last) >= 0.03
    }
}
