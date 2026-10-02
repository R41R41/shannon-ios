import Foundation

/// The wire between this app and the embed page (`Live2D/embed/README.md`): calls into
/// `window.shannonBody`, and messages the page posts to the `shannonBody` handler.
/// Everything here is pure, so the encoding is tested without a web view.

/// What part of her the page frames, and how far the owner moved it.
public struct ShannonLive2DLayout: Equatable, Sendable {
    public enum Mode: String, CaseIterable, Sendable {
        case full
        case bust
        /// Soft on a 3x screen (texture resolution); kept for completeness, not offered in the UI.
        case face
    }

    public static let scaleRange: ClosedRange<Double> = 0.5...3

    public var mode: Mode
    public var scale: Double
    public var offsetX: Double
    public var offsetY: Double

    public init(mode: Mode = .bust, scale: Double = 1, offsetX: Double = 0, offsetY: Double = 0) {
        self.mode = mode
        self.scale = scale
        self.offsetX = offsetX
        self.offsetY = offsetY
    }

    public var isMoved: Bool { scale != 1 || offsetX != 0 || offsetY != 0 }

    /// The layout after a pinch and a two-finger drag, kept inside what stays on screen.
    public func adjusted(scaleBy factor: Double, movedBy translation: CGSize, in bounds: CGSize) -> ShannonLive2DLayout {
        var next = self
        next.scale = min(Self.scaleRange.upperBound, max(Self.scaleRange.lowerBound, scale * (factor.isFinite && factor > 0 ? factor : 1)))
        let limitX = max(0, bounds.width) * 0.6
        let limitY = max(0, bounds.height) * 0.6
        next.offsetX = min(limitX, max(-limitX, offsetX + translation.width))
        next.offsetY = min(limitY, max(-limitY, offsetY + translation.height))
        return next
    }
}

public enum ShannonLive2DPhase: String, Equatable, Sendable {
    case idle, thinking, listening, speaking

    /// The text and voice activity the app already shows, as the page's four phases.
    public init(_ activity: ShannonDialogueActivity) {
        switch activity {
        case .listening: self = .listening
        case .speaking: self = .speaking
        case .thinking, .working, .searching, .preparing, .connecting: self = .thinking
        case .idle, .waiting, .done, .failed: self = .idle
        }
    }
}

/// `setPresence`: what she is doing in her own time, as far as the app can read it as the owner.
public struct ShannonLive2DPresence: Equatable, Sendable {
    public var expression: String?
    public var feeling: String?
    public var intensity: Double
    public var doing: String
    public var awaitingReaction: Int

    public init(expression: String? = nil, feeling: String? = nil, intensity: Double = 0, doing: String = "idle", awaitingReaction: Int = 0) {
        self.expression = expression
        self.feeling = feeling
        self.intensity = intensity
        self.doing = doing
        self.awaitingReaction = awaitingReaction
    }
}

public enum ShannonLive2DCommand: Equatable, Sendable {
    case express(expression: String, feeling: String?, seconds: Double?)
    case expressEmotion(name: String, intensity: Double)
    case setMood(valence: Double, arousal: Double, openness: Double)
    case setPresence(ShannonLive2DPresence)
    case setPhase(ShannonLive2DPhase)
    case setMouthLevel(Double)
    case play(String)
    case setLayout(ShannonLive2DLayout)
    case setPaused(Bool)
    case setTouchEnabled(Bool)
    case setFrameStats(Bool)

    /// One guarded statement. Names and numbers are encoded as JSON, so nothing the server
    /// sent (an expression name, a feeling) can become script.
    public var javaScript: String {
        let call: String
        switch self {
        case let .express(expression, feeling, seconds):
            call = "express(\(Self.json(expression)),\(feeling.map(Self.json) ?? "undefined"),\(seconds.map(Self.number) ?? "undefined"))"
        case let .expressEmotion(name, intensity):
            call = "expressEmotion(\(Self.json(name)),\(Self.number(min(1, max(0, intensity)))))"
        case let .setMood(valence, arousal, openness):
            call = "setMood({valence:\(Self.number(valence)),arousal:\(Self.number(arousal)),openness:\(Self.number(openness))})"
        case let .setPresence(presence):
            call = "setPresence({expression:\(presence.expression.map(Self.json) ?? "null"),feeling:\(presence.feeling.map(Self.json) ?? "null"),"
                + "intensity:\(Self.number(presence.intensity)),doing:\(Self.json(presence.doing)),awaitingReaction:\(max(0, presence.awaitingReaction))})"
        case let .setPhase(phase):
            call = "setPhase(\(Self.json(phase.rawValue)))"
        case let .setMouthLevel(level):
            call = "setMouthLevel(\(Self.number(min(1, max(0, level)))))"
        case let .play(gesture):
            call = "play(\(Self.json(gesture)))"
        case let .setLayout(layout):
            call = "setLayout({mode:\(Self.json(layout.mode.rawValue)),scale:\(Self.number(layout.scale)),"
                + "offsetX:\(Self.number(layout.offsetX)),offsetY:\(Self.number(layout.offsetY))})"
        case let .setPaused(paused):
            call = "setPaused(\(paused))"
        case let .setTouchEnabled(enabled):
            call = "setTouchEnabled(\(enabled))"
        case let .setFrameStats(enabled):
            call = "setFrameStats(\(enabled))"
        }
        return "window.shannonBody&&window.shannonBody.\(call);"
    }

    private static func number(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        return String(format: "%.3f", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    private static func json(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        // `["…"]` without its brackets. U+2028/2029 are legal in JSON and line breaks in older script engines.
        return String(text.dropFirst().dropLast())
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}

/// One touch as the page reports it. The types are the body contract's touch vocabulary.
public struct ShannonLive2DTouch: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case pet, tickle, poke, holdHand
    }

    public let id: String
    public let occurredAt: String
    public let kind: Kind
    public let durationMs: Int
    public let strength: Double
    public let ongoing: Bool

    public init(id: String, occurredAt: String, kind: Kind, durationMs: Int, strength: Double, ongoing: Bool) {
        self.id = id
        self.occurredAt = occurredAt
        self.kind = kind
        self.durationMs = durationMs
        self.strength = strength
        self.ongoing = ongoing
    }
}

public enum ShannonLive2DMessage: Equatable, Sendable {
    case ready(version: String, modelUpdatedAt: String, expressions: [String], gestures: [String])
    case error(String)
    /// A touch ended.
    case touch(ShannonLive2DTouch)
    /// The moment to ask whether she says something.
    case askReaction(ShannonLive2DTouch)
    case tap
    case frameStats(fps: Int)

    private static let identifier = try? NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")

    /// Reads a posted message. Anything malformed is nil: the page is bundled, but a message is still input.
    public init?(body: Any) {
        guard let object = body as? [String: Any], let type = object["type"] as? String else { return nil }
        switch type {
        case "ready":
            self = .ready(
                version: String((object["version"] as? String ?? "").prefix(40)),
                modelUpdatedAt: String((object["modelUpdatedAt"] as? String ?? "").prefix(40)),
                expressions: Self.names(object["expressions"]),
                gestures: Self.names(object["gestures"])
            )
        case "error":
            self = .error(String((object["message"] as? String ?? "").prefix(200)))
        case "touch", "askReaction":
            guard let id = object["id"] as? String, Self.isIdentifier(id),
                  let occurredAt = object["occurredAt"] as? String, occurredAt.count <= 40,
                  let touch = object["touch"] as? [String: Any],
                  let kind = (touch["type"] as? String).flatMap(ShannonLive2DTouch.Kind.init(rawValue:)),
                  let duration = (touch["durationMs"] as? NSNumber)?.doubleValue, duration.isFinite else { return nil }
            let strength = (touch["strength"] as? NSNumber)?.doubleValue ?? 0
            let value = ShannonLive2DTouch(
                id: id, occurredAt: occurredAt, kind: kind,
                durationMs: Int(min(600_000, max(0, duration.rounded()))),
                strength: strength.isFinite ? min(1, max(0, strength)) : 0,
                ongoing: type == "askReaction" && (touch["ongoing"] as? Bool ?? false)
            )
            self = type == "touch" ? .touch(value) : .askReaction(value)
        case "tap":
            self = .tap
        case "frameStats":
            guard let fps = (object["fps"] as? NSNumber)?.intValue else { return nil }
            self = .frameStats(fps: max(0, min(240, fps)))
        default:
            return nil
        }
    }

    static func isIdentifier(_ value: String) -> Bool {
        guard let identifier else { return false }
        return identifier.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    private static func names(_ value: Any?) -> [String] {
        ((value as? [Any]) ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty && $0.count <= 40 }.prefix(64).map { $0 }
    }
}
