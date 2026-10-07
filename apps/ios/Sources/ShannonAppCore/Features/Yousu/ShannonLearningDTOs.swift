import Foundation

/// `GET /v1/autonomy/values` (`docs/cognition-ledger-contract.md`, 「Owner controls」): the versions of her value table, the
/// active version's cells and whether it is frozen. `POST /v1/autonomy/values/rollback` and `/resume` answer the same view.
/// Only a paired device of the owner's scope may read it. The calibration and the choices by status are not read here.
public struct ShannonValuesDTO: Decodable, Equatable, Sendable {
    public struct Version: Decodable, Equatable, Sendable, Identifiable {
        public let versionId: String
        public let createdAt: String
        /// `sleep`, `owner_rollback` or `owner_resume`.
        public let madeBy: String
        public let baseVersion: String?
        /// The places in the order of settling of the choices it learned from (1-based, inclusive); 0 and 0 for none.
        public let evidenceFrom: Int
        public let evidenceTo: Int
        public let state: String
        public let frozen: Bool

        public var id: String { versionId }

        public init(versionId: String, createdAt: String, madeBy: String, baseVersion: String? = nil, evidenceFrom: Int, evidenceTo: Int, state: String, frozen: Bool) {
            self.versionId = versionId
            self.createdAt = createdAt
            self.madeBy = madeBy
            self.baseVersion = baseVersion
            self.evidenceFrom = evidenceFrom
            self.evidenceTo = evidenceTo
            self.state = state
            self.frozen = frozen
        }
    }

    public struct Cell: Decodable, Equatable, Sendable {
        /// `root`, `family`, `choice`, `band` or `presence`.
        public let level: String
        public let choice: String
        public let context: String
        public let n: Int
        public let mean: Double
        public let uncertainty: Double
        public let lastAt: String?

        public init(level: String, choice: String, context: String = "", n: Int, mean: Double, uncertainty: Double = 0.05, lastAt: String?) {
            self.level = level
            self.choice = choice
            self.context = context
            self.n = n
            self.mean = mean
            self.uncertainty = uncertainty
            self.lastAt = lastAt
        }
    }

    public let active: Version?
    public let frozen: Bool
    /// The newest thirty, oldest first.
    public let versions: [Version]
    public let cells: [Cell]

    public init(active: Version?, frozen: Bool, versions: [Version], cells: [Cell]) {
        self.active = active
        self.frozen = frozen
        self.versions = versions
        self.cells = cells
    }
}

/// One skill as `GET /v1/autonomy/skills` lists it (`docs/skill-and-routing-contract.md`, 「ライ氏の学びの画面」), and as
/// `POST /v1/autonomy/skills/{id}/pin` and `/unpin` answer.
public struct ShannonSkillDTO: Decodable, Equatable, Sendable, Identifiable {
    public struct Trial: Decodable, Equatable, Sendable {
        /// The version a failed trial returns to; nil for a new skill.
        public let baseVersion: Int?
        public let uses: Int
        public let of: Int

        public init(baseVersion: Int?, uses: Int, of: Int) {
            self.baseVersion = baseVersion
            self.uses = uses
            self.of = of
        }
    }

    public let id: String
    /// A closed symbol (`weekly-review`).
    public let name: String
    /// One line in her words: what the skill is for.
    public let description: String
    /// `trial`, `active` or `retired`.
    public let status: String
    public let statusReason: String?
    public let version: Int
    public var pinned: Bool
    public let ownerVersion: Bool
    public let trial: Trial?
    /// Settled uses, and how many of them succeeded.
    public let uses: Int
    public let successes: Int

    public init(
        id: String, name: String, description: String, status: String, statusReason: String? = nil, version: Int,
        pinned: Bool, ownerVersion: Bool = false, trial: Trial? = nil, uses: Int, successes: Int
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.status = status
        self.statusReason = statusReason
        self.version = version
        self.pinned = pinned
        self.ownerVersion = ownerVersion
        self.trial = trial
        self.uses = uses
        self.successes = successes
    }

    public var isRetired: Bool { status == "retired" }
}

public struct ShannonSkillsDTO: Decodable, Equatable, Sendable {
    public struct Capacity: Decodable, Equatable, Sendable {
        public let used: Int
        public let limit: Int

        public init(used: Int, limit: Int) {
            self.used = used
            self.limit = limit
        }
    }

    public let capacity: Capacity
    public var skills: [ShannonSkillDTO]

    public init(capacity: Capacity, skills: [ShannonSkillDTO]) {
        self.capacity = capacity
        self.skills = skills
    }
}

/// `GET /v1/autonomy/skills/{id}`: the skill, its SKILL.md (or, with `bodyHidden`, a neutral note in its place) and its versions.
public struct ShannonSkillDetailDTO: Decodable, Equatable, Sendable {
    public struct Revision: Decodable, Equatable, Sendable {
        public let version: Int
        /// `version`, or `snapshot` (the safety copy taken before a rollback; not listed).
        public let kind: String
        /// `sleep`, `conversation`, `owner` or `shannon_copy`.
        public let actor: String
        public let reason: String?
        public let uses: Int?
        public let successes: Int?
        public let createdAt: String?

        public init(version: Int, kind: String, actor: String, reason: String?, uses: Int?, successes: Int?, createdAt: String?) {
            self.version = version
            self.kind = kind
            self.actor = actor
            self.reason = reason
            self.uses = uses
            self.successes = successes
            self.createdAt = createdAt
        }
    }

    public let skill: ShannonSkillDTO
    public let body: String
    public let bodyHidden: Bool
    public let versions: [Revision]

    private enum CodingKeys: String, CodingKey { case body, bodyHidden, versions }

    public init(skill: ShannonSkillDTO, body: String, bodyHidden: Bool, versions: [Revision]) {
        self.skill = skill
        self.body = body
        self.bodyHidden = bodyHidden
        self.versions = versions
    }

    public init(from decoder: Decoder) throws {
        skill = try ShannonSkillDTO(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        body = try container.decode(String.self, forKey: .body)
        // Anything but an explicit false hides the body: a server that does not say is not trusted to have checked.
        bodyHidden = (try container.decodeIfPresent(Bool.self, forKey: .bodyHidden)) ?? true
        versions = (try container.decodeIfPresent([Revision].self, forKey: .versions)) ?? []
    }
}
