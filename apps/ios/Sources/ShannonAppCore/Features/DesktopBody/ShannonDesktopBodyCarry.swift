import CoreGraphics
import Foundation

/// Telling a carry (`touch.carry`: she is picked up and put down elsewhere) from the touches the page knows.
///
/// The embed page has no carry: a window cannot be moved from inside it. So the window decides first, by the rule of
/// the Windows body (owner decision 2026-10-06): she is picked up only by her face or by what has no named part (her
/// boots), `ShannonDesktopBodyGrip`. A press anywhere else (her head and hair, neck, chest, waist, legs, skirt, arms,
/// hands…) goes to the page at once and stays a touch. A press where she may be picked up is held for a moment: moved
/// more than a few points, she is carried and the page never hears of it; released at once, the page gets the click
/// (a poke, a tap); held still, the page gets the press and what follows. Pure, so it is tested without a window.
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

    enum State: Equatable, Sendable {
        case idle
        case pending(start: CGPoint, origin: CGPoint, at: TimeInterval)
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

    /// A press at `point` (screen), where she may be picked up (`mayCarry`) or not, while her window's origin is `origin`.
    public mutating func down(at point: CGPoint, mayCarry: Bool, origin: CGPoint, time: TimeInterval) -> [Effect] {
        if !mayCarry {
            state = .passthrough
            return [.deliverDown]
        }
        state = .pending(start: point, origin: origin, at: time)
        return []
    }

    public mutating func drag(to point: CGPoint, time: TimeInterval) -> [Effect] {
        switch state {
        case .idle:
            return []
        case .passthrough:
            return [.deliverDrag]
        case let .pending(start, origin, at):
            if hypot(point.x - start.x, point.y - start.y) > Self.carryDistance {
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
        guard case let .pending(_, _, at) = state, time - at >= Self.holdSeconds else { return [] }
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
