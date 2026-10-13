import Foundation

/// What earlier pages did, which decides whether another page is loaded ahead of a screen.
struct ShannonLive2DWarmHistory: Equatable, Sendable {
    /// The last memory warning; forgotten once a screen has shown her again.
    var memoryWarnedAt: Date?
    /// When the last page loaded ahead of a screen started loading.
    var lastWarmAt: Date?
    /// Pages in a row that ended without once saying `ready` (the stage's own count).
    var failuresWithoutReady = 0
}

/// How long the iPhone keeps a loaded page nobody sees, and when it loads one ahead of a screen
/// (`ShannonLive2DStage+Keep.swift`; owner request 2026-10-14, review of 19fca582).
extension ShannonLive2DStagePolicy {
    /// On the iPhone, with the Waterlight form chosen, a page loaded before is kept (paused, parked out of sight) this long
    /// after a screen last showed her, so that switching back to the Live2D form (ボット → ガール) shows her at once.
    static let keepInOtherFormSeconds: TimeInterval = 30 * 60
    /// In the background a parked page is kept this long with the Live2D form chosen (with the Waterlight form, not at all).
    /// A short trip to another app (a message, a look at the calendar) mostly ends within a few minutes and finds her as
    /// she was; past ten minutes a return is a new visit, and the page is loaded again 2 s after it, ahead of Talk. The time
    /// only runs out while the app runs in the background (a call, playing audio, a background task): an app the system
    /// suspends has its page's process suspended with it, and the system ends that process first if memory runs short.
    static let backgroundKeepSeconds: TimeInterval = 10 * 60
    /// After a memory warning no page is loaded ahead at launch or on a return to the front for this long, or until a
    /// screen has shown her once: otherwise warning, release and the reload 2 s after the next activation could repeat.
    static let memoryWarningQuietSeconds: TimeInterval = 10 * 60
    /// After a page that never became ready, the next page loaded ahead waits this long after the last one.
    static let warmRetrySeconds: TimeInterval = 5 * 60
    /// A release that wakes later than this was asleep in a suspended app, which may be coming to the front: it looks
    /// again this much later, once the system has said where the app is.
    static let lateWakeSeconds: TimeInterval = 5
    /// At launch or on a return to the front the page waits this long, so that it does not compete with the conversation's first load.
    static let launchWarmDelaySeconds: TimeInterval = 2

    /// How long a loaded page is kept after the last screen showing her went away; nil keeps it until memory runs short
    /// (a memory warning lets it go at once). `parks` is the iPhone, where a page waits paused in its parking place: there,
    /// with the Live2D form chosen she is only out of sight (Talk's scroll display, reading the conversation, another tab),
    /// and the next screen shows her from the page as it is. Elsewhere (the Mac) the page is let go as before.
    static func keepSeconds(formIsLive2D: Bool, parks: Bool) -> TimeInterval? {
        guard parks else { return releaseAfterSeconds }
        return formIsLive2D ? nil : keepInOtherFormSeconds
    }

    /// How much longer a page nobody sees is kept, from now: what is left of `keepSeconds` since she was last seen
    /// (`unseenFor`; an activation or a change of form does not start it again), and on the iPhone in the background
    /// (`backgroundFor`, nil in front) what is left of `backgroundKeepSeconds`. nil: until memory runs short. In front
    /// with the Live2D form chosen nothing changes: the page is there for the next screen.
    static func keepRemaining(formIsLive2D: Bool, parks: Bool, unseenFor: TimeInterval, backgroundFor: TimeInterval?) -> TimeInterval? {
        var limits: [TimeInterval] = []
        if let keep = keepSeconds(formIsLive2D: formIsLive2D, parks: parks) { limits.append(keep - unseenFor) }
        if parks, let backgroundFor { limits.append((formIsLive2D ? backgroundKeepSeconds : 0) - backgroundFor) }
        return limits.min().map { max(0, $0) }
    }

    /// Where the keeping time runs from: when she was last seen, or the owner's change of form if that came later
    /// (choosing ボット gives a page parked for an hour in ガール its 30 minutes from then). An activation changes nothing.
    static func keepingSince(_ unseenSince: Date?, formChanged: Bool, now: Date) -> Date? {
        formChanged && unseenSince != nil ? now : unseenSince
    }

    /// Why the page would be loaded before a screen shows her.
    enum Warming: String, Equatable, Sendable {
        /// The owner has just chosen the Live2D form (ボット → ガール): a screen will show her in a moment.
        case chosen
        /// Talk appeared (the app came up) with the Live2D form chosen.
        case launch
        /// The app came back to the front with the Live2D form chosen (also after Control Center or Face ID).
        case foreground
    }

    /// Loading ahead is free of network (the page is bundled) but costs a second or two of work: on the owner's own
    /// choice it is always done, at launch or on a return to the front only outside Low Power Mode.
    static func warms(_ reason: Warming, lowPower: Bool) -> Bool {
        reason == .chosen || !lowPower
    }

    /// Whether the page is loaded now, ahead of a screen: only for the Live2D form, only when nothing is loaded or loading
    /// (a failed page waits for the owner's もう一度読み込む), and only while no screen shows her (a screen loads it itself).
    /// Pages that never became ready are not loaded ahead again and again: after one, the next waits `warmRetrySeconds`;
    /// after `failuresWithoutReadyLimit`, only a screen loads the page (and shows the failure). After a memory warning,
    /// only the owner's own choice loads it ahead until `memoryWarningQuietSeconds` have passed or a screen has shown her.
    static func warmsAhead(
        form: ShannonForm, status: ShannonLive2DStage.Status, hasHosts: Bool, reason: Warming, lowPower: Bool,
        history: ShannonLive2DWarmHistory = ShannonLive2DWarmHistory(), now: Date = Date()
    ) -> Bool {
        guard form == .live2d, status == .unloaded, !hasHosts, warms(reason, lowPower: lowPower) else { return false }
        guard history.failuresWithoutReady < failuresWithoutReadyLimit else { return false }
        if history.failuresWithoutReady > 0, let last = history.lastWarmAt, now.timeIntervalSince(last) < warmRetrySeconds { return false }
        if reason != .chosen, let warned = history.memoryWarnedAt, now.timeIntervalSince(warned) < memoryWarningQuietSeconds { return false }
        return true
    }
}
