import Foundation

/// One call of the body page for the stream page, as JSON data and never as script: `{"call":"express","args":[…]}`.
/// The stream page calls only the names it knows (`stream.js`), with these arguments.
struct ShannonStreamOutputEvent: Equatable, Sendable {
    let call: String
    let payload: String

    /// The calls a stream page is given: her faces, mood, presence, phase, mouth, gestures and body. What only the app's
    /// own window decides (where she stands, pausing, touch, frame rate, calm, diagnostics) is the stream page's own.
    static let calls: Set<String> = ["express", "expressEmotion", "setMood", "setPresence", "setPhase", "setMouthLevel", "play", "setBody"]

    init?(call: String, args: [Any]) {
        guard Self.calls.contains(call),
              JSONSerialization.isValidJSONObject(["call": call, "args": args] as [String: Any]),
              let data = try? JSONSerialization.data(withJSONObject: ["call": call, "args": args] as [String: Any], options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8), text.utf8.count <= 8_000 else { return nil }
        self.call = call
        self.payload = text
    }
}

extension ShannonLive2DCommand {
    /// The same call for a stream page, or nil for what the stream page decides by itself.
    var streamEvent: ShannonStreamOutputEvent? {
        func value(_ text: String?) -> Any { text.map { $0 as Any } ?? NSNull() }
        func number(_ value: Double) -> Double { value.isFinite ? value : 0 }
        switch self {
        case let .express(expression, feeling, seconds):
            return ShannonStreamOutputEvent(call: "express", args: [expression, value(feeling), seconds.map { number($0) as Any } ?? NSNull()])
        case let .expressEmotion(name, intensity):
            return ShannonStreamOutputEvent(call: "expressEmotion", args: [name, min(1, max(0, number(intensity)))])
        case let .setMood(valence, arousal, openness):
            return ShannonStreamOutputEvent(call: "setMood", args: [["valence": number(valence), "arousal": number(arousal), "openness": number(openness)]])
        case let .setPresence(presence):
            // The body contract's presence: a face and its strength, what she is doing, and how many stories wait. Never a cause or a title.
            return ShannonStreamOutputEvent(call: "setPresence", args: [[
                "expression": value(presence.expression), "feeling": value(presence.feeling), "intensity": number(presence.intensity),
                "doing": presence.doing, "awaitingReaction": max(0, presence.awaitingReaction),
            ] as [String: Any]])
        case let .setPhase(phase):
            return ShannonStreamOutputEvent(call: "setPhase", args: [phase.rawValue])
        case let .setMouthLevel(level):
            return ShannonStreamOutputEvent(call: "setMouthLevel", args: [min(1, max(0, number(level)))])
        case let .play(gesture):
            return ShannonStreamOutputEvent(call: "play", args: [gesture])
        case let .setBody(body):
            return ShannonStreamOutputEvent(call: "setBody", args: [body.rawValue])
        case .setLayout, .setPaused, .setTouchEnabled, .setFrameStats, .setIdle, .setFrameRate:
            return nil
        }
    }
}

/// What a page that starts watching is told first, and which calls are worth sending at all. The lasting state (her
/// body, mood, presence and phase) is kept for the next page; faces, gestures and the mouth are moments and are not.
struct ShannonStreamOutputSnapshot: Equatable, Sendable {
    /// The order a new page is told them in: the body first, because the page starts in it.
    static let lasting = ["setBody", "setMood", "setPresence", "setPhase"]

    private(set) var latest: [String: ShannonStreamOutputEvent] = [:]
    private(set) var body: ShannonLive2DBody = .human
    private var mouthLevel = 0.0

    init(body: ShannonLive2DBody = .human) {
        latest["setBody"] = ShannonLive2DCommand.setBody(body).streamEvent
        self.body = body
    }

    /// Takes a command; answers the event to send now, or nil when it changes nothing for a watching page.
    mutating func take(_ command: ShannonLive2DCommand) -> ShannonStreamOutputEvent? {
        guard let event = command.streamEvent else { return nil }
        switch command {
        case let .setMouthLevel(level):
            // As the app's own page: a change of note, and always the return to zero. Her eyes alone have no mouth.
            guard ShannonLive2DStagePolicy.sendsMouthLevel(level, last: mouthLevel, body: body) else { return nil }
            mouthLevel = level
            return event
        case let .play(gesture):
            return body.hasCharacterRig && !gesture.isEmpty ? event : nil
        case let .setBody(value):
            if value != body { mouthLevel = 0 }
            body = value
        default:
            break
        }
        guard Self.lasting.contains(event.call) else { return event }
        guard latest[event.call] != event else { return nil }
        latest[event.call] = event
        return event
    }

    /// What a page that just connected is told, in order.
    var opening: [ShannonStreamOutputEvent] {
        Self.lasting.compactMap { latest[$0] }
    }
}
