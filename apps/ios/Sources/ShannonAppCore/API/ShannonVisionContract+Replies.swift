import Foundation

/// `vision.decision.v1`: one Decisions call (predicate and choice in one request), what it chose and what it cost.
public struct ShannonVisionDecision: Codable, Equatable, Sendable {
    public struct Gate: Codable, Equatable, Sendable {
        public var probability: Double?
        public var threshold: Double

        public func encode(to encoder: any Encoder) throws {
            var row = encoder.container(keyedBy: CodingKeys.self)
            try row.encode(probability, forKey: .probability)
            try row.encode(threshold, forKey: .threshold)
        }
    }

    public struct Probability: Codable, Equatable, Sendable {
        public var id: String
        public var probability: Double
    }

    public struct Choice: Codable, Equatable, Sendable {
        public var candidateId: String?
        public var confidence: Double?
        public var probabilities: [Probability]

        public func encode(to encoder: any Encoder) throws {
            var row = encoder.container(keyedBy: CodingKeys.self)
            try row.encode(candidateId, forKey: .candidateId)
            try row.encode(confidence, forKey: .confidence)
            try row.encode(probabilities, forKey: .probabilities)
        }
    }

    public struct Timings: Codable, Equatable, Sendable {
        public var queuedMs: Int
        public var decisionMs: Int?
        public var totalMs: Int

        public func encode(to encoder: any Encoder) throws {
            var row = encoder.container(keyedBy: CodingKeys.self)
            try row.encode(queuedMs, forKey: .queuedMs)
            try row.encode(decisionMs, forKey: .decisionMs)
            try row.encode(totalMs, forKey: .totalMs)
        }
    }

    public struct Cost: Codable, Equatable, Sendable {
        public var reservedUsd: Double
        public var estimatedUsd: Double?
        public var inputTokens: Int?
        public var usageComplete: Bool

        public func encode(to encoder: any Encoder) throws {
            var row = encoder.container(keyedBy: CodingKeys.self)
            try row.encode(reservedUsd, forKey: .reservedUsd)
            try row.encode(estimatedUsd, forKey: .estimatedUsd)
            try row.encode(inputTokens, forKey: .inputTokens)
            try row.encode(usageComplete, forKey: .usageComplete)
        }
    }

    public var schema: String
    public var decisionId: String
    public var frameId: String
    public var sessionId: String
    public var generation: Int
    public var source: ShannonVisionSource
    public var candidates: [String]
    public var gate: Gate
    public var choice: Choice
    public var outcome: ShannonVisionDecisionOutcome
    public var discardReason: ShannonVisionDiscardReason?
    public var timings: Timings
    public var cost: Cost
    public var degrade: Int
    public var decidedAt: String

    public func encode(to encoder: any Encoder) throws {
        var row = encoder.container(keyedBy: CodingKeys.self)
        try row.encode(schema, forKey: .schema)
        try row.encode(decisionId, forKey: .decisionId)
        try row.encode(frameId, forKey: .frameId)
        try row.encode(sessionId, forKey: .sessionId)
        try row.encode(generation, forKey: .generation)
        try row.encode(source, forKey: .source)
        try row.encode(candidates, forKey: .candidates)
        try row.encode(gate, forKey: .gate)
        try row.encode(choice, forKey: .choice)
        try row.encode(outcome, forKey: .outcome)
        try row.encode(discardReason, forKey: .discardReason)
        try row.encode(timings, forKey: .timings)
        try row.encode(cost, forKey: .cost)
        try row.encode(degrade, forKey: .degrade)
        try row.encode(decidedAt, forKey: .decidedAt)
    }
}

/// `vision.frame.reply.v1`: what the worker answers a frame with. A reaction is shown on the device at once;
/// a notice or an escalation needs nothing here (the server speaks through the Talk).
public struct ShannonVisionFrameReply: Codable, Equatable, Sendable {
    public enum Watch: String, Codable, Sendable { case `continue`, stop }

    public var schema: String
    public var frameId: String
    public var watch: Watch
    public var stopReason: ShannonVisionStopReason?
    public var outcome: ShannonVisionDecisionOutcome
    public var candidateId: String?
    public var reaction: ShannonVisionReaction?
    public var degrade: Int
    public var nextFrameNotBefore: String

    /// The reaction to show: the named one, or the one its chosen candidate names.
    public var reactionToShow: ShannonVisionReaction? {
        reaction ?? candidateId.flatMap(ShannonVisionCandidate.init(id:))?.reaction
    }

    public func encode(to encoder: any Encoder) throws {
        var row = encoder.container(keyedBy: CodingKeys.self)
        try row.encode(schema, forKey: .schema)
        try row.encode(frameId, forKey: .frameId)
        try row.encode(watch, forKey: .watch)
        try row.encode(stopReason, forKey: .stopReason)
        try row.encode(outcome, forKey: .outcome)
        try row.encode(candidateId, forKey: .candidateId)
        try row.encode(reaction, forKey: .reaction)
        try row.encode(degrade, forKey: .degrade)
        try row.encode(nextFrameNotBefore, forKey: .nextFrameNotBefore)
    }
}

/// `vision.status.v1` (`GET /v1/vision/status`): whether the device may watch now, and the limits it must keep.
public struct ShannonVisionStatus: Codable, Equatable, Sendable {
    public struct Limits: Codable, Equatable, Sendable {
        public var judgeFramesPerSecond: Double
        public var sendIntervalMs: Int
        public var longSide: Int
        public var frameBytes: Int
        public var ttlMs: Int

        public init(judgeFramesPerSecond: Double, sendIntervalMs: Int, longSide: Int, frameBytes: Int, ttlMs: Int) {
            self.judgeFramesPerSecond = judgeFramesPerSecond
            self.sendIntervalMs = sendIntervalMs
            self.longSide = longSide
            self.frameBytes = frameBytes
            self.ttlMs = ttlMs
        }
    }

    public var schema: String
    public var watchAllowed: Bool
    public var reason: ShannonVisionStopReason?
    public var degrade: Int
    public var limits: Limits

    public init(watchAllowed: Bool, reason: ShannonVisionStopReason?, degrade: Int, limits: Limits) {
        self.schema = "vision.status.v1"
        self.watchAllowed = watchAllowed
        self.reason = reason
        self.degrade = degrade
        self.limits = limits
    }

    public func encode(to encoder: any Encoder) throws {
        var row = encoder.container(keyedBy: CodingKeys.self)
        try row.encode(schema, forKey: .schema)
        try row.encode(watchAllowed, forKey: .watchAllowed)
        try row.encode(reason, forKey: .reason)
        try row.encode(degrade, forKey: .degrade)
        try row.encode(limits, forKey: .limits)
    }
}

/// What came of sending one frame.
public enum ShannonVisionFrameResult: Equatable, Sendable {
    case reply(ShannonVisionFrameReply)
    /// 429: not now; the next frame waits until this time.
    case notNow(until: Date)
    /// 502, 503, 504 or no answer at all: the vision worker is down, and watching stops (ADR-0011 §8.1).
    case workerDown
    /// Any other refusal (an older server without the route, an expired pairing, a frame it would not take).
    case rejected(status: Int)
}

/// The API watching needs. A client without it (an older stub, a design preview) never watches.
public protocol ShannonVisionServing: Sendable {
    /// The paired device's id when this client knows it, for `source.deviceId`.
    var visionDeviceId: String? { get }
    func visionStatus() async throws -> ShannonVisionStatus
    func sendVisionFrame(_ frame: ShannonVisionFrame, jpeg: Data) async -> ShannonVisionFrameResult
    func reportVisionPresence(personCount: Int, at: Date) async throws
}

public enum ShannonVisionWire {
    public static let frameHeader = "x-shannon-vision-frame"
    /// How long to wait after a 429 that names no time.
    public static let notNowSeconds: TimeInterval = 2

    /// The frame's metadata as one compact line of JSON, for the header.
    public static func headerValue(_ frame: ShannonVisionFrame) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(frame), as: UTF8.self)
    }

    /// `2026-10-14T09:00:00.000Z`.
    public static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    public static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
