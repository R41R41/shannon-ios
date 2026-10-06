import CoreGraphics
import Foundation

/// Telling a carry (`touch.carry`: she is picked up and put down elsewhere) from the touches the page knows.
///
/// The embed page has no carry: a window cannot be moved from inside it. So the window decides first, by the rule of
/// the Windows body (owner decision 2026-10-06): she is picked up only by her face or by what has no named part (her
/// boots), `ShannonDesktopBodyGrip`. A press anywhere else (her head and hair, neck, chest, waist, legs, skirt, arms,
/// hands…) goes to the page at once and stays a touch. A press where she may be picked up is held for a moment: moved
/// more than a few points, she is carried and the page never hears of it; released at once, the page gets the click
/// (a poke, a tap); held still, the page gets the press and what follows. A press whose part the page is still being
/// asked about (`Grip.asking`) is held the same way until the answer (`decided`); moved far enough before it, the
/// fallback decides. Pure, so it is tested without a window.
/// Times are the events' own (seconds since the Mac started, as `NSEvent.timestamp` gives them).
public struct ShannonDesktopBodyCarry: Equatable, Sendable {
    public enum Effect: Equatable, Sendable {
        /// Hand the held press to the page now.
        case deliverDown
        case deliverDrag
        case deliverUp
        case beginCarry
        /// Move the window so that her origin is here (screen coordinates).
        case moveWindow(CGPoint)
        /// She was put down after being carried this long.
        case endCarry(durationMs: Int)
    }

    /// What is known of the pressed point when the press begins.
    public enum Grip: Equatable, Sendable {
        /// She may be picked up here.
        case carry
        /// Not here: the press is the page's at once.
        case touch
        /// The page is being asked (`partAt`); `fallback` decides if she is moved before it answers.
        case asking(fallback: Bool)
    }

    enum State: Equatable, Sendable {
        case idle
        /// `undecided`: the page has not answered yet, and `fallback` stands for its answer.
        case pending(start: CGPoint, origin: CGPoint, at: TimeInterval, undecided: Bool = false, fallback: Bool = true)
        case passthrough
        case carrying(start: CGPoint, origin: CGPoint, at: TimeInterval)
    }

    /// Movement that makes a press a carry.
    public static let carryDistance = 4.0
    /// A press held this long without moving is the page's.
    public static let holdSeconds = 0.25

    private(set) var state = State.idle

    public init() {}

    public var isCarrying: Bool { if case .carrying = state { true } else { false } }
    public var isPressed: Bool { state != .idle }
    /// The press is held for the page's answer.
    public var awaitsDecision: Bool { if case .pending(_, _, _, true, _) = state { true } else { false } }

    /// A press at `point` (screen), where she may be picked up (`mayCarry`) or not, while her window's origin is `origin`.
    public mutating func down(at point: CGPoint, mayCarry: Bool, origin: CGPoint, time: TimeInterval) -> [Effect] {
        down(at: point, grip: mayCarry ? .carry : .touch, origin: origin, time: time)
    }

    public mutating func down(at point: CGPoint, grip: Grip, origin: CGPoint, time: TimeInterval) -> [Effect] {
        switch grip {
        case .touch:
            state = .passthrough
            return [.deliverDown]
        case .carry:
            state = .pending(start: point, origin: origin, at: time)
        case let .asking(fallback):
            state = .pending(start: point, origin: origin, at: time, undecided: true, fallback: fallback)
        }
        return []
    }

    /// The page answered for the press it is held for. Not where she may be picked up: the press is the page's now.
    /// An answer for a press that has already been decided (moved, held, released) changes nothing.
    public mutating func decided(mayCarry: Bool) -> [Effect] {
        guard case let .pending(start, origin, at, true, _) = state else { return [] }
        if mayCarry {
            state = .pending(start: start, origin: origin, at: at)
            return []
        }
        state = .passthrough
        return [.deliverDown]
    }

    public mutating func drag(to point: CGPoint, time: TimeInterval) -> [Effect] {
        switch state {
        case .idle:
            return []
        case .passthrough:
            return [.deliverDrag]
        case let .pending(start, origin, at, undecided, fallback):
            if hypot(point.x - start.x, point.y - start.y) > Self.carryDistance {
                guard !undecided || fallback else {
                    state = .passthrough
                    return [.deliverDown, .deliverDrag]
                }
                state = .carrying(start: start, origin: origin, at: at)
                return [.beginCarry, .moveWindow(Self.moved(origin, from: start, to: point))]
            }
            if time - at >= Self.holdSeconds {
                state = .passthrough
                return [.deliverDown, .deliverDrag]
            }
            return []
        case let .carrying(start, origin, _):
            return [.moveWindow(Self.moved(origin, from: start, to: point))]
        }
    }

    /// Time passing with the button held and no movement.
    public mutating func tick(time: TimeInterval) -> [Effect] {
        guard case let .pending(_, _, at, _, _) = state, time - at >= Self.holdSeconds else { return [] }
        state = .passthrough
        return [.deliverDown]
    }

    public mutating func up(time: TimeInterval) -> [Effect] {
        defer { state = .idle }
        switch state {
        case .idle: return []
        case .pending: return [.deliverDown, .deliverUp]
        case .passthrough: return [.deliverUp]
        case let .carrying(_, _, at): return [.endCarry(durationMs: Int(max(0, min(600_000, (time - at) * 1000)).rounded()))]
        }
    }

    /// The press went away without a release (the window closed, the app lost the mouse).
    public mutating func cancel(time: TimeInterval) -> [Effect] {
        switch state {
        case .carrying: return up(time: time)
        case .passthrough:
            state = .idle
            return [.deliverUp]
        case .idle, .pending:
            state = .idle
            return []
        }
    }

    static func moved(_ origin: CGPoint, from start: CGPoint, to point: CGPoint) -> CGPoint {
        CGPoint(x: origin.x + point.x - start.x, y: origin.y + point.y - start.y)
    }
}
