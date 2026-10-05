import Foundation
#if os(macOS)
import AppKit
import CoreGraphics
#endif

/// Whether the owner is at the Mac (`desktop.pc-presence`), from how long it has not been used and whether the screen
/// is locked, asleep or under the screen saver. The same boundaries as the Windows body (`idleInput.ts`): ten minutes
/// without input is "away", input within the last thirty seconds after that is "back". A locked screen is away at once.
public struct ShannonDesktopBodyAway: Equatable, Sendable {
    public enum Change: Equatable, Sendable {
        case away(minutes: Int)
        case returned(minutes: Int)
    }

    public static let awayAfterSeconds = 600.0
    public static let backWithinSeconds = 30.0
    /// Input this recent means he is beside her (a line of a moment, one of her messages).
    public static let presentWithinSeconds = 120.0

    public private(set) var isAway = false
    /// When he last used the Mac before he went.
    private var leftAt: Date?
    private var idleSeconds = 0.0
    private var locked = false

    public init() {}

    /// He is at the Mac and has used it lately.
    public var isPresent: Bool { !isAway && !locked && idleSeconds < Self.presentWithinSeconds }

    public mutating func observe(idleSeconds: Double, locked: Bool, now: Date) -> Change? {
        let idle = max(0, idleSeconds.isFinite ? idleSeconds : 0)
        self.idleSeconds = idle
        self.locked = locked
        if !isAway, locked || idle >= Self.awayAfterSeconds {
            isAway = true
            leftAt = now.addingTimeInterval(-idle)
            return .away(minutes: Self.minutes(idle))
        }
        guard isAway, !locked, idle < Self.backWithinSeconds else { return nil }
        isAway = false
        let away = now.addingTimeInterval(-idle).timeIntervalSince(leftAt ?? now)
        leftAt = nil
        return .returned(minutes: Self.minutes(away))
    }

    static func minutes(_ seconds: Double) -> Int { Int(min(10_080, max(0, (seconds / 60).rounded()))) }
}

/// When a line of a moment (`GET /v1/body/nudges`) may be said, as the Windows body decides it (`main.ts`):
/// 「おかえりなさい」 a few seconds after he is back, the morning (05–10) and late-night (23–04) lines once a day,
/// 「長く話していない」 after two hours beside her without a word, and the story waiting for his reaction when one
/// more is waiting. At most two an hour and ten a day, never during a conversation nor 15 minutes after one.
public struct ShannonDesktopBodyNudgeClock: Equatable, Sendable {
    public static let perHour = 2
    public static let perDay = 10
    public static let quietAfterConversation: TimeInterval = 15 * 60
    public static let longQuiet: TimeInterval = 2 * 60 * 60
    public static let retryAfter: TimeInterval = 10 * 60

    private var shown: [Date] = []
    private var lastConversationAt: Date?
    private var presentSince: Date?
    private var longQuietAt: Date?
    /// The day a once-a-day line was said, and when one was last tried.
    private var saidOn: [String: String] = [:]
    private var triedAt: [String: Date] = [:]

    public init() {}

    public mutating func noteConversation(at now: Date) { lastConversationAt = now }

    /// Room for one more line now.
    public func allows(now: Date) -> Bool {
        if let lastConversationAt, now.timeIntervalSince(lastConversationAt) < Self.quietAfterConversation { return false }
        let hour = shown.filter { now.timeIntervalSince($0) < 3_600 }.count
        let day = shown.filter { now.timeIntervalSince($0) < 86_400 }.count
        return hour < Self.perHour && day < Self.perDay
    }

    /// The scene that is due now while he is beside her, if any. Called every minute.
    public mutating func dueScene(now: Date, present: Bool, calendar: Calendar = .current) -> String? {
        guard present else {
            presentSince = nil
            return nil
        }
        presentSince = presentSince ?? now
        let hour = calendar.component(.hour, from: now)
        if (5..<10).contains(hour) { return onceADay("morning", now: now, calendar: calendar) }
        if hour >= 23 || hour < 4 { return onceADay("lateNight", now: now, calendar: calendar) }
        let quietSince = max(presentSince ?? now, lastConversationAt ?? .distantPast, longQuietAt ?? .distantPast)
        guard now.timeIntervalSince(quietSince) >= Self.longQuiet else { return nil }
        longQuietAt = now
        return "longQuiet"
    }

    private mutating func onceADay(_ scene: String, now: Date, calendar: Calendar) -> String? {
        guard saidOn[scene] != Self.day(now, calendar), now.timeIntervalSince(triedAt[scene] ?? .distantPast) >= Self.retryAfter else { return nil }
        triedAt[scene] = now
        return scene
    }

    /// A line was said.
    public mutating func noteShown(scene: String, at now: Date, calendar: Calendar = .current) {
        shown = shown.filter { now.timeIntervalSince($0) < 86_400 } + [now]
        if scene == "morning" || scene == "lateNight" { saidOn[scene] = Self.day(now, calendar) }
    }

    static func day(_ date: Date, _ calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
    }
}

#if os(macOS)
/// Reads the Mac: seconds since the last input (no permission is needed for it), and whether the screen is locked,
/// asleep or under the screen saver. Nothing of what he does is read, only that something was done.
@MainActor
final class ShannonDesktopBodyMacState {
    private(set) var screenLocked = false
    private(set) var screensAsleep = false
    private(set) var saverRunning = false
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    var changed: (@MainActor () -> Void)?

    var isLocked: Bool { screenLocked || screensAsleep || saverRunning }

    /// Seconds since any keyboard, mouse or trackpad input on this Mac.
    var idleSeconds: Double {
        guard let any = CGEventType(rawValue: UInt32.max) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }

    func start() {
        guard observers.isEmpty else { return }
        let distributed = DistributedNotificationCenter.default()
        let workspace = NSWorkspace.shared.notificationCenter
        watch(distributed, "com.apple.screenIsLocked") { $0.screenLocked = true }
        watch(distributed, "com.apple.screenIsUnlocked") { $0.screenLocked = false }
        watch(distributed, "com.apple.screensaver.didstart") { $0.saverRunning = true }
        watch(distributed, "com.apple.screensaver.didstop") { $0.saverRunning = false }
        watch(workspace, NSWorkspace.screensDidSleepNotification.rawValue) { $0.screensAsleep = true }
        watch(workspace, NSWorkspace.screensDidWakeNotification.rawValue) { $0.screensAsleep = false }
        watch(workspace, NSWorkspace.willSleepNotification.rawValue) { $0.screensAsleep = true }
        watch(workspace, NSWorkspace.didWakeNotification.rawValue) { $0.screensAsleep = false }
    }

    func stop() {
        for (center, observer) in observers { center.removeObserver(observer) }
        observers = []
    }

    private func watch(_ center: NotificationCenter, _ name: String, _ apply: @escaping @MainActor (ShannonDesktopBodyMacState) -> Void) {
        let observer = center.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                apply(self)
                self.changed?()
            }
        }
        observers.append((center, observer))
    }
}
#endif
