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
    /// Fit the framed part to the width as well (`fit: 'contain'`), so that a square frame cuts off no hair or shoulder.
    public var contained: Bool

    public init(mode: Mode = .bust, scale: Double = 1, offsetX: Double = 0, offsetY: Double = 0, contained: Bool = false) {
        self.mode = mode
        self.scale = scale
        self.offsetX = offsetX
        self.offsetY = offsetY
        self.contained = contained
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

/// Turns a pinch's running scale and a drag's running translation into steps, so that the layout
/// is moved a little on every change and simply stays where it is when a finger lifts.
struct ShannonLive2DGestureTracker: Equatable {
    private var lastScale = 1.0
    private var lastTranslation = CGSize.zero

    mutating func beginPinch() { lastScale = 1 }
    mutating func beginPan() { lastTranslation = .zero }

    /// The factor since the last call.
    mutating func pinch(scale: Double) -> Double {
        guard scale.isFinite, scale > 0, lastScale > 0 else { return 1 }
        defer { lastScale = scale }
        return scale / lastScale
    }

    /// The movement since the last call.
    mutating func pan(translation: CGSize) -> CGSize {
        defer { lastTranslation = translation }
        return CGSize(width: translation.width - lastTranslation.width, height: translation.height - lastTranslation.height)
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
    /// Less movement of her own: no gestures she starts by herself, and how much her head and body sway (1 = as usual).
    case setIdle(gestures: Bool, sway: Double)
    /// At most this many frames a second (15–60); 0 follows the display.
    case setFrameRate(Int)
    /// The character or her eyes alone. A body shown for the first time is loaded first; the page says `body` when it switched.
    case setBody(ShannonLive2DBody)

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
                + "offsetX:\(Self.number(layout.offsetX)),offsetY:\(Self.number(layout.offsetY)),fit:\(layout.contained ? "\"contain\"" : "null")})"
        case let .setPaused(paused):
            call = "setPaused(\(paused))"
        case let .setTouchEnabled(enabled):
            call = "setTouchEnabled(\(enabled))"
        case let .setFrameStats(enabled):
            call = "setFrameStats(\(enabled))"
        case let .setIdle(gestures, sway):
            // An older page has no such call: asked for only when it is there.
            return "window.shannonBody&&typeof window.shannonBody.setIdle==='function'&&window.shannonBody.setIdle({gestures:\(gestures),sway:\(Self.number(min(1, max(0, sway))))});"
        case let .setFrameRate(framesPerSecond):
            return "window.shannonBody&&typeof window.shannonBody.setFrameRate==='function'&&window.shannonBody.setFrameRate(\(max(0, min(60, framesPerSecond))));"
        case let .setBody(body):
            return "window.shannonBody&&typeof window.shannonBody.setBody==='function'&&window.shannonBody.setBody(\(Self.json(body.rawValue)));"
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

    /// Which part of her was touched (the body contract's vocabulary).
    public enum Region: String, CaseIterable, Sendable {
        case head, face, side, hand, body
    }

    public let id: String
    public let occurredAt: String
    public let kind: Kind
    public let durationMs: Int
    public let strength: Double
    public let ongoing: Bool
    /// As the page said. An older page says nothing; `sentRegion` then fills in what the gesture implies.
    public let region: Region?

    public init(id: String, occurredAt: String, kind: Kind, durationMs: Int, strength: Double, ongoing: Bool, region: Region? = nil) {
        self.id = id
        self.occurredAt = occurredAt
        self.kind = kind
        self.durationMs = durationMs
        self.strength = strength
        self.ongoing = ongoing
        self.region = region
    }

    /// The part reported to her: the page's own, or, where the gesture leaves no doubt, the gesture's
    /// (a pet is on the head, a held hand is the hand, a tickle is on the side). A poke without a part stays without one.
    public var sentRegion: Region? {
        if let region { return region }
        switch kind {
        case .pet: return .head
        case .holdHand: return .hand
        case .tickle: return .side
        case .poke: return nil
        }
    }
}

public enum ShannonLive2DMessage: Equatable, Sendable {
    /// `bodies` and `body`: the bodies the page has and the one it shows. An older page has only the character and says neither.
    case ready(
        version: String, modelUpdatedAt: String, expressions: [String], gestures: [String],
        bodies: [ShannonLive2DBody] = [], body: ShannonLive2DBody? = nil)
    /// The page switched to this body (after `setBody`).
    case body(ShannonLive2DBody)
    /// How far the page is with loading (0–0.9). It arrives only before the first `ready`, and means the page is alive.
    case loading(progress: Double)
    /// The page could not draw. `contextLost`: the drawing surface was lost and the page could not make it again.
    case error(String, code: String? = nil)
    /// The drawing surface was lost; the page is making it again by itself.
    case contextLost
    /// The surface is back. `body`: the body shown, from a page that says it (the page of 09:55 does not).
    case contextRestored(body: ShannonLive2DBody? = nil)
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
                gestures: Self.names(object["gestures"]),
                // A body this app does not know (a newer page) is left out, not the message.
                bodies: Self.names(object["bodies"]).compactMap(ShannonLive2DBody.init(rawValue:)),
                body: (object["body"] as? String).flatMap(ShannonLive2DBody.init(rawValue:))
            )
        case "body":
            guard let body = (object["body"] as? String).flatMap(ShannonLive2DBody.init(rawValue:)) else { return nil }
            self = .body(body)
        case "loading":
            let progress = (object["progress"] as? NSNumber)?.doubleValue ?? 0
            self = .loading(progress: progress.isFinite ? min(1, max(0, progress)) : 0)
        case "error":
            self = .error(String((object["message"] as? String ?? "").prefix(200)), code: (object["code"] as? String).map { String($0.prefix(40)) })
        case "contextLost":
            self = .contextLost
        case "contextRestored":
            self = .contextRestored(body: (object["body"] as? String).flatMap(ShannonLive2DBody.init(rawValue:)))
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
                ongoing: type == "askReaction" && (touch["ongoing"] as? Bool ?? false),
                // A part outside the vocabulary (a newer page) is dropped, not the touch.
                region: (touch["region"] as? String).flatMap(ShannonLive2DTouch.Region.init(rawValue:))
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
