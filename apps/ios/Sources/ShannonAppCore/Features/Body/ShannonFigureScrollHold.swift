import Foundation

/// A finger on her figure inside a screen that scrolls (the call screen, owner decision 2026-10-14 「触れるようにする」): while a
/// finger that landed on her is down, the screen's own scrolling is held, so a stroke on her is a touch and not a scroll. A
/// finger that lands anywhere else scrolls as before, and buttons are never touched by this (only the scroll's pan is held,
/// and only while that finger is down). A figure that takes no touch never holds anything.
struct ShannonFigureScrollHold: Equatable, Sendable {
    private(set) var holding = false

    /// Only the call screen's figure, whose screen scrolls as a whole, holds it. Talk's figure stands outside its scrolling
    /// words and keeps every gesture as it was; the timeline's small figure takes no touch.
    static func applies(to priority: ShannonLive2DHostPriority) -> Bool { priority == .voice }

    /// What the enclosing scroll's pan becomes now: `false` held, `true` released, nil left as it is.
    mutating func fingers(down: Bool, touchEnabled: Bool, inScroll: Bool) -> Bool? {
        if down {
            guard touchEnabled, inScroll, !holding else { return nil }
            holding = true
            return false
        }
        guard holding else { return nil }
        holding = false
        return true
    }
}
