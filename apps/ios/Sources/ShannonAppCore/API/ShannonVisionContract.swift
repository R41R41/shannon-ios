import Foundation

// The Swift mirror of the common vision contract (Syzygy ADR-0011 §3.2, stage 1), `services/api/src/contracts/visionContract.ts`.
// Both sides read `services/api/tests/fixtures/vision-contract-v1.json`. A record describes a frame, a session or a decision;
// none of them has a field that could carry a picture or a way to keep one (no `persist`, bytes, base64 or URL). The JPEG of
// a frame travels only as the body of `POST /v1/vision/frames` and is never part of these records.

/// Where a frame came from.
public enum ShannonVisionSourceKind: String, Codable, CaseIterable, Sendable {
    case appCamera = "app_camera"
    case appLook = "app_look"
    case bodyLook = "body_look"
    case photo
    case minecraft
    case screen
    case stream
}

/// §3.2 privacy of what a frame shows.
public enum ShannonVisionPrivacy: String, Codable, CaseIterable, Sendable {
    case ownerPrivate = "owner_private"
    case sharedRoom = "shared_room"
    case worldShared = "world_shared"
    case streamPublic = "stream_public"
}

/// The listener when a frame was captured (ADR-0002's audience classes).
public enum ShannonVisionAudience: String, Codable, CaseIterable, Sendable {
    case ownerAlone = "owner_alone"
    case others
    case stream
}

/// Why the device's edge gate let a frame through.
public enum ShannonVisionGateReason: String, Codable, CaseIterable, Sendable {
    case difference
    case ownerAsked = "owner_asked"
    case firstFrame = "first_frame"
}

/// The reactions registered on the device (`react:<id>`): each is an expression the app shows at once.
public enum ShannonVisionReaction: String, Codable, CaseIterable, Sendable {
    case smile
    case surprised
    case curious
    case tender
    case concerned

    /// The face of the app that shows this reaction.
    public var expression: ShannonExpressionDTO {
        switch self {
        case .smile: .joyful
        case .surprised: .surprised
        case .curious: .curious
        case .tender: .tender
        case .concerned: .concerned
        }
    }
}

/// The kinds of topic a camera notice may raise (`notice:<category>`).
public enum ShannonVisionNoticeCategory: String, Codable, CaseIterable, Sendable {
    case ownerReturned = "owner_returned"
    case ownerWaved = "owner_waved"
    case showingSomething = "showing_something"
    case newObject = "new_object"
    case ownerLooksTired = "owner_looks_tired"
}

public enum ShannonVisionCandidateKind: String, Codable, CaseIterable, Sendable {
    case quiet
    case react
    case notice
    case escalate
    case other
}

public enum ShannonVisionDecisionOutcome: String, Codable, CaseIterable, Sendable {
    case chosen
    case quiet
    case discarded
    case refused
    case failed
    case skipped
}

public enum ShannonVisionDiscardReason: String, Codable, CaseIterable, Sendable {
    case staleGeneration = "stale_generation"
    case expired
    case audienceChanged = "audience_changed"
    case belowGate = "below_gate"
    case lowConfidence = "low_confidence"
    case budget
    case degraded
    case busy
    case disabled
    case repeated
    case timeout
    case httpError = "http_error"
    case usageUnknown = "usage_unknown"
    case invalidAnswer = "invalid_answer"
    case capped
}

public enum ShannonVisionSessionGoal: String, Codable, CaseIterable, Sendable {
    case notice
    case reflex
    case look
}

public enum ShannonVisionEndReason: String, Codable, CaseIterable, Sendable {
    case completed
    case hazardCleared = "hazard_cleared"
    case targetLost = "target_lost"
    case noProgress = "no_progress"
    case noCandidates = "no_candidates"
    case observationUnavailable = "observation_unavailable"
    case cancelled
    case deadline
    case decisionLimit = "decision_limit"
    case actionLimit = "action_limit"
    case staleGeneration = "stale_generation"
    case audienceChanged = "audience_changed"
    case budget
    case degraded
    case returned
    case unknown
}

/// Why the worker stops a device from watching.
public enum ShannonVisionStopReason: String, Codable, CaseIterable, Sendable {
    case audience
    case degraded
    case disabled
    case budget
}

/// One candidate of the closed vocabulary: `quiet`, `react:<id>`, `notice:<category>`, `escalate`, `other`.
public struct ShannonVisionCandidate: Equatable, Sendable {
    public let kind: ShannonVisionCandidateKind
    public let reaction: ShannonVisionReaction?
    public let category: ShannonVisionNoticeCategory?

    public var id: String {
        switch kind {
        case .react: "react:\(reaction?.rawValue ?? "")"
        case .notice: "notice:\(category?.rawValue ?? "")"
        default: kind.rawValue
        }
    }

    /// Parses a candidate id, or nil for one outside the closed vocabulary.
    public init?(id: String) {
        if let plain = ShannonVisionCandidateKind(rawValue: id), plain != .react, plain != .notice {
            self.init(kind: plain, reaction: nil, category: nil)
            return
        }
        let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        if parts[0] == "react", let reaction = ShannonVisionReaction(rawValue: parts[1]) {
            self.init(kind: .react, reaction: reaction, category: nil)
        } else if parts[0] == "notice", let category = ShannonVisionNoticeCategory(rawValue: parts[1]) {
            self.init(kind: .notice, reaction: nil, category: category)
        } else {
            return nil
        }
    }

    init(kind: ShannonVisionCandidateKind, reaction: ShannonVisionReaction?, category: ShannonVisionNoticeCategory?) {
        self.kind = kind
        self.reaction = reaction
        self.category = category
    }
}

// MARK: - Records

/// Every optional field is written as `null` (the server's closed records require each key).
public struct ShannonVisionSource: Codable, Equatable, Sendable {
    public var kind: ShannonVisionSourceKind
    public var bodyId: String?
    public var deviceId: String?

    public init(kind: ShannonVisionSourceKind, bodyId: String?, deviceId: String?) {
        self.kind = kind
        self.bodyId = bodyId
        self.deviceId = deviceId
    }

    public func encode(to encoder: any Encoder) throws {
        var row = encoder.container(keyedBy: CodingKeys.self)
        try row.encode(kind, forKey: .kind)
        try row.encode(bodyId, forKey: .bodyId)
        try row.encode(deviceId, forKey: .deviceId)
    }
}

/// Size and format of a frame, for cost and latency. Never the pixels.
public struct ShannonVisionEncoding: Codable, Equatable, Sendable {
    public enum Format: String, Codable, Sendable { case jpeg, png }
    public var width: Int
    public var height: Int
    public var format: Format
    public var byteLength: Int

    public init(width: Int, height: Int, format: Format, byteLength: Int) {
        self.width = width
        self.height = height
        self.format = format
        self.byteLength = byteLength
    }
}

public struct ShannonVisionGate: Codable, Equatable, Sendable {
    public var reason: ShannonVisionGateReason
    public var difference: Double?
    public var personCount: Int?

    public init(reason: ShannonVisionGateReason, difference: Double?, personCount: Int?) {
        self.reason = reason
        self.difference = difference
        self.personCount = personCount
    }

    public func encode(to encoder: any Encoder) throws {
        var row = encoder.container(keyedBy: CodingKeys.self)
        try row.encode(reason, forKey: .reason)
        try row.encode(difference, forKey: .difference)
        try row.encode(personCount, forKey: .personCount)
    }
}

/// `vision.frame.v1`: one frame, described. The pixels stay in the memory of whoever holds `frameId`.
/// The device sends no structured `state` in stage 1, so the field is always `null` here.
public struct ShannonVisionFrame: Codable, Equatable, Sendable {
    public static let schemaName = "vision.frame.v1"
    public var schema = Self.schemaName
    public var frameId: String
    public var capturedAt: String
    public var receivedAt: String?
    public var source: ShannonVisionSource
    public var sessionId: String?
    public var generation: Int?
    public var privacy: ShannonVisionPrivacy
    public var audienceAtCapture: ShannonVisionAudience
    public var ttlMs: Int
    public var encoding: ShannonVisionEncoding
    public var gate: ShannonVisionGate?
    /// Always null from this app. Decoded only to read the fixture; a non-null state from elsewhere is not kept.
    public var state: ShannonVisionNull?

    public init(
        frameId: String, capturedAt: String, receivedAt: String? = nil, source: ShannonVisionSource, sessionId: String?,
        generation: Int?, privacy: ShannonVisionPrivacy, audienceAtCapture: ShannonVisionAudience, ttlMs: Int,
        encoding: ShannonVisionEncoding, gate: ShannonVisionGate?
    ) {
        self.frameId = frameId
        self.capturedAt = capturedAt
        self.receivedAt = receivedAt
        self.source = source
        self.sessionId = sessionId
        self.generation = generation
        self.privacy = privacy
        self.audienceAtCapture = audienceAtCapture
        self.ttlMs = ttlMs
        self.encoding = encoding
        self.gate = gate
        self.state = nil
    }

    public func encode(to encoder: any Encoder) throws {
        var row = encoder.container(keyedBy: CodingKeys.self)
        try row.encode(schema, forKey: .schema)
        try row.encode(frameId, forKey: .frameId)
        try row.encode(capturedAt, forKey: .capturedAt)
        try row.encode(receivedAt, forKey: .receivedAt)
        try row.encode(source, forKey: .source)
        try row.encode(sessionId, forKey: .sessionId)
        try row.encode(generation, forKey: .generation)
        try row.encode(privacy, forKey: .privacy)
        try row.encode(audienceAtCapture, forKey: .audienceAtCapture)
        try row.encode(ttlMs, forKey: .ttlMs)
        try row.encode(encoding, forKey: .encoding)
        try row.encode(gate, forKey: .gate)
        try row.encode(state, forKey: .state)
    }
}

/// A value that is always JSON `null` (the frame's `state` from this app). Any other value is read as absent.
public struct ShannonVisionNull: Codable, Equatable, Sendable {
    public init(from decoder: any Decoder) throws {}
    public func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        try value.encodeNil()
    }
}

/// `vision.session.v1`: one bounded run of decisions for one source, under a generation.
public struct ShannonVisionSession: Codable, Equatable, Sendable {
    public struct Budget: Codable, Equatable, Sendable {
        public var maxDecisions: Int
        public var maxDurationMs: Int
    }

    public enum State: String, Codable, Sendable { case open, ended }

    public var schema: String
    public var sessionId: String
    public var generation: Int
    public var source: ShannonVisionSource
    public var goal: ShannonVisionSessionGoal
    public var parentTaskId: String?
    public var startedAt: String
    public var deadlineAt: String
    public var budget: Budget
    public var state: State
    public var endReason: ShannonVisionEndReason?
    public var endedAt: String?

    public func encode(to encoder: any Encoder) throws {
        var row = encoder.container(keyedBy: CodingKeys.self)
        try row.encode(schema, forKey: .schema)
        try row.encode(sessionId, forKey: .sessionId)
        try row.encode(generation, forKey: .generation)
        try row.encode(source, forKey: .source)
        try row.encode(goal, forKey: .goal)
        try row.encode(parentTaskId, forKey: .parentTaskId)
        try row.encode(startedAt, forKey: .startedAt)
        try row.encode(deadlineAt, forKey: .deadlineAt)
        try row.encode(budget, forKey: .budget)
        try row.encode(state, forKey: .state)
        try row.encode(endReason, forKey: .endReason)
        try row.encode(endedAt, forKey: .endedAt)
    }
}
