import Foundation

/// Which screen shows the one figure when several are on screen at once (a cover over the dialogue
/// stage, a sheet over a call). The higher one wins; among equals, the one that appeared last.
/// Her desktop body on the Mac (A17) is above all: while she stands on the desktop, the places in the
/// app's windows show the Waterlight Eye.
public enum ShannonLive2DHostPriority: Int, Comparable, Sendable {
    case hero, dialogue, voice, bodyScreen, desktop

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
    /// A page that calms itself (no gestures, half the frames) still draws; in Low Power Mode it is stopped after this long idle.
    static let restAfterSecondsInPage: TimeInterval = 60
    static func rests(calm: Bool, phase: ShannonLive2DPhase, idleSeconds: TimeInterval, fingerDown: Bool = false, calmsInPage: Bool = false) -> Bool {
        calm && !fingerDown && phase == .idle && idleSeconds >= (calmsInPage ? restAfterSecondsInPage : restAfterSeconds)
    }

    /// Whether an idle figure is ever paused to rest: always for a page that cannot calm itself; for one that
    /// can, only in Low Power Mode (Reduce Motion alone is fully served by the page's own calm).
    static func mayRest(reduceMotion: Bool, lowPower: Bool, calmsInPage: Bool) -> Bool {
        calmsInPage ? lowPower : (reduceMotion || lowPower)
    }

    /// One automatic reload per minute; a second failure inside it is shown as failed.
    static let reloadSpacingSeconds: TimeInterval = 60
    /// A page that has failed this many times in a row without once saying `ready` is not reloaded again.
    static let failuresWithoutReadyLimit = 2
    /// `ignoringSpacing`: the first reload of an unanswered body switch (`ShannonLive2DBodySwitch`).
    static func mayReload(lastReloadAt: Date?, now: Date, failuresWithoutReady: Int = 0, ignoringSpacing: Bool = false) -> Bool {
        guard failuresWithoutReady < failuresWithoutReadyLimit else { return false }
        guard !ignoringSpacing, let lastReloadAt else { return true }
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
    static let loadSilenceSeconds: TimeInterval = 40

    static func loadTimedOut(waited: TimeInterval, silent: TimeInterval) -> Bool {
        waited >= loadTimeoutSeconds || silent >= loadSilenceSeconds
    }

    /// Low Power Mode halves the drawn frames; otherwise the display's own rate.
    static func frameRate(lowPower: Bool) -> Int { lowPower ? 30 : 0 }
    /// With no screen showing her, the model (about 85 MB of GPU memory) is let go after this long.
    static let releaseAfterSeconds: TimeInterval = 90

    /// The page to open: `embed.html`, with `?body=eyes` when she starts with her eyes alone.
    static func pageURL(in folder: URL, body: ShannonLive2DBody) -> URL {
        let page = folder.appendingPathComponent("embed.html")
        guard body != .human, var components = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return page }
        components.queryItems = [URLQueryItem(name: "body", value: body.rawValue)]
        return components.url ?? page
    }

    /// A mouth level worth a call: any change of note, and always the return to zero. Her eyes alone have no mouth.
    static func sendsMouthLevel(_ level: Double, last: Double, body: ShannonLive2DBody = .human) -> Bool {
        guard body.hasCharacterRig else { return false }
        return level <= 0 ? last > 0 : abs(level - last) >= 0.03
    }

    /// A gesture the page named, for the character only: her eyes alone have no arms.
    static func playsGesture(_ gesture: String, known: [String], body: ShannonLive2DBody) -> Bool {
        body.hasCharacterRig && known.contains(gesture)
    }

    /// Where the screen in front wants her, and whether she may be touched there.
    static func hostCommands(layout: ShannonLive2DLayout, touchEnabled: Bool) -> [ShannonLive2DCommand] {
        [.setLayout(layout), .setTouchEnabled(touchEnabled)]
    }

    /// Reduce Motion: no gestures of her own and no sway. Low Power Mode: half the frames.
    static func calmCommands(reduceMotion: Bool, lowPower: Bool) -> [ShannonLive2DCommand] {
        [.setIdle(gestures: !reduceMotion, sway: reduceMotion ? 0 : 1), .setFrameRate(frameRate(lowPower: lowPower))]
    }
}
