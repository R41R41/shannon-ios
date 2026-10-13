import Foundation

/// The reads of 「ようす › 目標」 and 「ようす › 点検」 (Syzygy ADR-0009 stage 2, E7; `docs/executive-ui-contract.md`). Every field
/// but an item's `id` may be missing: a server that does not send a part yet shows it as empty, never as a failure, and one
/// item the app cannot read is left out instead of losing the whole list.

/// Decodes one element of a list on its own: an element that cannot be read becomes nil and is dropped.
struct ShannonLossy<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

extension KeyedDecodingContainer {
    /// The readable elements of a list, or an empty list when the key is missing or not a list.
    func lossyList<Value: Decodable & Sendable>(_ type: Value.Type, forKey key: Key) -> [Value] {
        ((try? decodeIfPresent([ShannonLossy<Value>].self, forKey: key)) ?? nil)?.compactMap(\.value) ?? []
    }

    /// A value of the expected type, or nil when it is missing or of another type.
    func lenient<Value: Decodable>(_ type: Value.Type, forKey key: Key) -> Value? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

// MARK: Goals

/// `GET /v1/autonomy/goals`, and the answer of `POST /v1/autonomy/pursuits/{id}/confirm`.
public struct ShannonGoalsDTO: Equatable, Sendable {
    public struct Completion: Decodable, Equatable, Sendable {
        /// The condition in plain Japanese, as the server words it (「5篇そろって、ライ氏が読む」).
        public var summary: String?
        /// The evidence suggests the condition is met: the owner may want to confirm.
        public var met: Bool?
    }

    public struct Goal: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public var title: String?
        public var why: String?
        /// `active`, `resting`, `done` or `dropped`.
        public var status: String?
        /// `seed`, `conversation` or `self`.
        public var origin: String?
        /// The interest the goal came from, in words.
        public var interest: String?
        /// 0...1.
        public var progress: Double?
        /// 「3/5」, as the server words the progress.
        public var progressLabel: String?
        public var reviewAt: String?
        public var lastWorkedAt: String?
        public var completion: Completion?
        public var evidenceCount: Int?
        /// Why it was closed or rested, in words.
        public var closedReason: String?
        public var closedAt: String?
        public var ownerCanConfirm: Bool?
        public var ownerCanRest: Bool?
        public var ownerCanDrop: Bool?
        public var createdAt: String?
        public var updatedAt: String?

        public var isSeed: Bool { origin == "seed" }
        public var isActive: Bool { status == "active" }
        public var isOpen: Bool { status == "active" || status == "resting" }
        /// The server's word wins; without it, a seed is never changed by the owner (`PURSUIT_SEED_IMMUTABLE`).
        public var canConfirm: Bool { ownerCanConfirm ?? (!isSeed && isActive) }
        public var canRest: Bool { ownerCanRest ?? (!isSeed && isActive) }
        public var canDrop: Bool { ownerCanDrop ?? (!isSeed && isOpen) }
    }

    public var generatedAt: String?
    /// How many goals may be active at once (8).
    public var activeLimit: Int?
    public var goals: [Goal]
}

extension ShannonGoalsDTO: Decodable {
    private enum CodingKeys: String, CodingKey { case generatedAt, activeLimit, goals }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = container.lenient(String.self, forKey: .generatedAt)
        activeLimit = container.lenient(Int.self, forKey: .activeLimit)
        goals = container.lossyList(Goal.self, forKey: .goals)
    }
}

// MARK: Choices

/// `GET /v1/autonomy/choices?days=7`: what the executive chose, the newest first.
public struct ShannonChoicesDTO: Equatable, Sendable {
    public struct Choice: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public var at: String?
        /// The capability chosen (`create`, `notify`, `rest`, ...).
        public var capability: String?
        /// What was chosen, in words (「詩を1篇書いた」).
        public var label: String?
        public var goalId: String?
        public var goalTitle: String?
        /// Her one-line reason (80 characters at most).
        public var reason: String?
        /// `pending`, `running`, `done`, `failed`, `unknown`, `cancelled` or `none`.
        public var outcome: String?
        /// Chosen from outside the candidates the code offered.
        public var offCandidates: Bool?
        /// The candidate with the highest value was chosen.
        public var topByValue: Bool?
    }

    public var generatedAt: String?
    public var days: Int?
    public var choices: [Choice]
}

extension ShannonChoicesDTO: Decodable {
    private enum CodingKeys: String, CodingKey { case generatedAt, days, choices }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = container.lenient(String.self, forKey: .generatedAt)
        days = container.lenient(Int.self, forKey: .days)
        choices = container.lossyList(Choice.self, forKey: .choices)
    }
}

// MARK: Capabilities

/// `GET /v1/autonomy/capabilities`: the catalogue of what she can do (E1).
public struct ShannonCapabilitiesDTO: Equatable, Sendable {
    public struct Value: Decodable, Equatable, Sendable {
        public var mean: Double?
        public var sd: Double?
        public var n: Int?
    }

    public struct Capability: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public var label: String?
        /// What it is for, in words.
        public var purpose: String?
        /// `activity` (the executive chooses it) or `tool` (a part used inside a task).
        public var layer: String?
        /// `procedure`, `fca` or `none`.
        public var execution: String?
        /// `own_time`, `owner_request_only` or `off`.
        public var policy: String?
        public var value: Value?
        public var uses7d: Int?
        public var usesTotal: Int?
        public var lastUsedAt: String?
    }

    public var generatedAt: String?
    public var capabilities: [Capability]
}

extension ShannonCapabilitiesDTO: Decodable {
    private enum CodingKeys: String, CodingKey { case generatedAt, capabilities }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = container.lenient(String.self, forKey: .generatedAt)
        capabilities = container.lossyList(Capability.self, forKey: .capabilities)
    }
}

// MARK: Inspection

/// `GET /v1/autonomy/inspection?day=`: the day's counts and the seven days ending on it (plan §6).
public struct ShannonInspectionDTO: Decodable, Equatable, Sendable {
    public struct Goals: Decodable, Equatable, Sendable {
        public var created: Int?
        public var completed: Int?
        public var rested: Int?
        public var dropped: Int?
    }

    public struct Notices: Decodable, Equatable, Sendable {
        public var sent: Int?
        /// The owner answered or reacted.
        public var answered: Int?
        /// No answer.
        public var unanswered: Int?
    }

    public struct Predictions: Decodable, Equatable, Sendable {
        public var made: Int?
        public var hit: Int?
    }

    public struct Counts: Decodable, Equatable, Sendable {
        public var deliberations: Int?
        public var choices: Int?
        /// Choices that took the candidate with the highest value.
        public var chosenTopValue: Int?
        public var offCandidates: Int?
        public var distinctCapabilities: Int?
        public var goals: Goals?
        public var notices: Notices?
        public var sleepRuns: Int?
        public var unknown: Int?
        public var spentYen: Double?
        public var skillUses: Int?
        public var predictions: Predictions?
    }

    public var generatedAt: String?
    /// `YYYY-MM-DD` in the owner's time zone.
    public var day: String?
    public var today: Counts?
    public var week: Counts?
}
