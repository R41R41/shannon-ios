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
    /// With no screen showing her, the model is let go after this long (the Mac; the iPhone keeps it, `keepSeconds`). Its textures alone are about 150 MB of GPU memory
    /// since the model of 2026-10-06 08:06 (two 4096 x 4096 and one 2048 x 2048, uncompressed RGBA; before it about 85 MB).
    static let releaseAfterSeconds: TimeInterval = 90
    /// On the iPhone, with the Waterlight form chosen, a page loaded before is kept (paused, parked out of sight) this long,
    /// so that switching back to the Live2D form (ボット → ガール) shows her at once instead of loading the page again.
    static let keepInOtherFormSeconds: TimeInterval = 30 * 60

    /// How long a loaded page is kept after the last screen showing her went away; nil keeps it until memory runs short
    /// (a memory warning lets it go at once). `parks` is the iPhone, where a page waits paused in its parking place: there,
    /// with the Live2D form chosen she is only out of sight (Talk's scroll display, reading the conversation, another tab),
    /// and the next screen shows her from the page as it is. Elsewhere (the Mac) the page is let go as before.
    static func keepSeconds(formIsLive2D: Bool, parks: Bool) -> TimeInterval? {
        guard parks else { return releaseAfterSeconds }
        return formIsLive2D ? nil : keepInOtherFormSeconds
    }

    /// Why the page would be loaded before a screen shows her.
    enum Warming: Equatable, Sendable {
        /// The app came up (or Talk appeared) with the Live2D form chosen.
        case launch
        /// The owner has just chosen the Live2D form (ボット → ガール): a screen will show her in a moment.
        case chosen
    }

    /// Loading ahead is free of network (the page is bundled) but costs a second or two of work: on the owner's own
    /// choice it is always done, at launch only outside Low Power Mode.
    static func warms(_ reason: Warming, lowPower: Bool) -> Bool {
        reason == .chosen || !lowPower
    }

    /// Whether the page is loaded now, ahead of a screen: only for the Live2D form, only when nothing is loaded or loading
    /// (a failed page waits for the owner's もう一度読み込む), and only while no screen shows her (a screen loads it itself).
    static func warmsAhead(form: ShannonForm, status: ShannonLive2DStage.Status, hasHosts: Bool, reason: Warming, lowPower: Bool) -> Bool {
        form == .live2d && status == .unloaded && !hasHosts && warms(reason, lowPower: lowPower)
    }

    /// At launch the page waits this long, so that it does not compete with the conversation's first load.
    static let launchWarmDelaySeconds: TimeInterval = 2

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
