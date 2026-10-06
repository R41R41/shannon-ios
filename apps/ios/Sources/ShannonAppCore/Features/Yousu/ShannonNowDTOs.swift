import Foundation

/// `GET /v1/shannon/now` (`docs/shannon-now-contract.md`): how Shannon is, for the owner's
/// own app. Closed vocabularies are kept as text so a value from a newer server (a delivery
/// surface, a refusal code, a kind of touch) never fails the page; `ShannonNowText` words
/// what it knows and stays neutral about the rest.

public struct ShannonNowFaceDTO: Decodable, Equatable, Sendable {
    public let expression: String
    public let feeling: String?
    /// `feeling.present` only.
    public let intensity: Double?
    /// `feeling.lingering` only.
    public let strength: Double?
    public let startedAt: String?

    public init(expression: String, feeling: String? = nil, intensity: Double? = nil, strength: Double? = nil, startedAt: String? = nil) {
        self.expression = expression
        self.feeling = feeling
        self.intensity = intensity
        self.strength = strength
        self.startedAt = startedAt
    }

    /// The face every other screen names (`uncomfortable` is `annoyed`). Nil for an expression this app has no name for.
    public var face: ShannonFace? {
        ShannonExpressionDTO.known(expression).map { ShannonFace(expression: $0, feelingName: feeling) }
    }
}

public struct ShannonNowFeelingDTO: Decodable, Equatable, Sendable {
    public let mood: ShannonNowFaceDTO?
    public let present: ShannonNowFaceDTO?
    public let lingering: [ShannonNowFaceDTO]

    public init(mood: ShannonNowFaceDTO? = nil, present: ShannonNowFaceDTO? = nil, lingering: [ShannonNowFaceDTO] = []) {
        self.mood = mood
        self.present = present
        self.lingering = lingering
    }

    private enum CodingKeys: String, CodingKey { case mood, present, lingering }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mood = try? container.decodeIfPresent(ShannonNowFaceDTO.self, forKey: .mood)
        present = try? container.decodeIfPresent(ShannonNowFaceDTO.self, forKey: .present)
        lingering = (try? container.decode(ShannonLossyList<ShannonNowFaceDTO>.self, forKey: .lingering))?.items ?? []
    }
}

public struct ShannonNowBodyDTO: Decodable, Equatable, Sendable {
    /// False while no body ever reported: the page says so instead of 「出ていません」.
    public let known: Bool
    public let present: Bool
    public let lastReadAt: String?
    public let camera: Bool?

    public init(known: Bool, present: Bool, lastReadAt: String? = nil, camera: Bool? = nil) {
        self.known = known
        self.present = present
        self.lastReadAt = lastReadAt
        self.camera = camera
    }

    private enum CodingKeys: String, CodingKey { case known, present, lastReadAt, camera }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        known = (try? container.decodeIfPresent(Bool.self, forKey: .known)) ?? false
        present = (try? container.decodeIfPresent(Bool.self, forKey: .present)) ?? false
        lastReadAt = try? container.decodeIfPresent(String.self, forKey: .lastReadAt)
        camera = try? container.decodeIfPresent(Bool.self, forKey: .camera)
    }
}

public struct ShannonNowLookDTO: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let at: String
    /// `owner`, `herself`, or `unknown`.
    public let askedBy: String?
    /// `body` or `app`.
    public let surface: String?
    public let outcome: String
    public let code: String?

    public init(id: String, at: String, askedBy: String? = nil, surface: String? = nil, outcome: String, code: String? = nil) {
        self.id = id
        self.at = at
        self.askedBy = askedBy
        self.surface = surface
        self.outcome = outcome
        self.code = code
    }
}

public struct ShannonNowTouchDTO: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let at: String
    public let kind: String
    public let count: Int?
    public let answered: Bool?
    /// The way of touching and the part, in the server's words (頬をつつかれた); absent when no part is known.
    public var phrase: String? = nil
    /// （iPhoneで）／（Windowsで）／（Macで）; absent when the surface is not known.
    public var place: String? = nil

    public init(id: String, at: String, kind: String, count: Int? = nil, answered: Bool? = nil, phrase: String? = nil, place: String? = nil) {
        self.id = id
        self.at = at
        self.kind = kind
        self.count = count
        self.answered = answered
        self.phrase = phrase
        self.place = place
    }
}

public struct ShannonNowDeliveryDTO: Decodable, Equatable, Sendable {
    public let surface: String
    public let outcome: String?
    public let at: String?
    /// For `earphones`: which app said it, `mac` or `iphone`.
    public let device: String?

    public init(surface: String, outcome: String? = nil, at: String? = nil, device: String? = nil) {
        self.surface = surface
        self.outcome = outcome
        self.at = at
        self.device = device
    }
}

public struct ShannonNowReachOutDTO: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let at: String
    public let reason: String?
    public let deliveries: [ShannonNowDeliveryDTO]

    public init(id: String, at: String, reason: String? = nil, deliveries: [ShannonNowDeliveryDTO] = []) {
        self.id = id
        self.at = at
        self.reason = reason
        self.deliveries = deliveries
    }

    private enum CodingKeys: String, CodingKey { case id, at, reason, deliveries }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        at = try container.decode(String.self, forKey: .at)
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        deliveries = (try? container.decode(ShannonLossyList<ShannonNowDeliveryDTO>.self, forKey: .deliveries))?.items ?? []
    }
}

public struct ShannonNowDTO: Decodable, Equatable, Sendable {
    public let generatedAt: String?
    public let feeling: ShannonNowFeelingDTO
    public let body: ShannonNowBodyDTO
    public let looks: [ShannonNowLookDTO]
    public let touches: [ShannonNowTouchDTO]
    public let reachOuts: [ShannonNowReachOutDTO]

    public init(
        generatedAt: String? = nil, feeling: ShannonNowFeelingDTO = .init(), body: ShannonNowBodyDTO = .init(known: false, present: false),
        looks: [ShannonNowLookDTO] = [], touches: [ShannonNowTouchDTO] = [], reachOuts: [ShannonNowReachOutDTO] = []
    ) {
        self.generatedAt = generatedAt
        self.feeling = feeling
        self.body = body
        self.looks = looks
        self.touches = touches
        self.reachOuts = reachOuts
    }

    private enum CodingKeys: String, CodingKey { case generatedAt, feeling, body, looks, touches, reachOuts }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try? container.decodeIfPresent(String.self, forKey: .generatedAt)
        feeling = (try? container.decodeIfPresent(ShannonNowFeelingDTO.self, forKey: .feeling)) ?? .init()
        body = (try? container.decodeIfPresent(ShannonNowBodyDTO.self, forKey: .body)) ?? .init(known: false, present: false)
        looks = (try? container.decode(ShannonLossyList<ShannonNowLookDTO>.self, forKey: .looks))?.items ?? []
        touches = (try? container.decode(ShannonLossyList<ShannonNowTouchDTO>.self, forKey: .touches))?.items ?? []
        reachOuts = (try? container.decode(ShannonLossyList<ShannonNowReachOutDTO>.self, forKey: .reachOuts))?.items ?? []
    }
}

/// What 「シャノンのいま」 reads of `GET /v1/autonomy`: her own time. The page keeps its own
/// small reading of that answer so it does not depend on which fields the autonomy screens decode.
public struct ShannonNowOwnTimeDTO: Decodable, Equatable, Sendable {
    /// What she is doing in her own time, in the server's words for the owner.
    public struct Session: Decodable, Equatable, Sendable {
        /// `active`, `held`, or `resting`.
        public let state: String
        public let label: String
        /// `resting`: when the next session may begin.
        public let until: String?
        /// `resting`: her reason, in her own words, when she chose to rest.
        public let reason: String?

        public init(state: String, label: String, until: String? = nil, reason: String? = nil) {
            self.state = state
            self.label = label
            self.until = until
            self.reason = reason
        }
    }

    public let control: ShannonAutonomyControlDTO
    public let loop: ShannonAutonomyLoopDTO?
    public let budget: ShannonAutonomyBudgetDTO
    public let budgetRequest: ShannonAutonomyBudgetRequestDTO?
    public let proposals: [ShannonAutonomyProposalDTO]
    public let session: Session?

    public init(
        control: ShannonAutonomyControlDTO, loop: ShannonAutonomyLoopDTO? = nil, budget: ShannonAutonomyBudgetDTO,
        budgetRequest: ShannonAutonomyBudgetRequestDTO? = nil, proposals: [ShannonAutonomyProposalDTO] = [], session: Session? = nil
    ) {
        self.control = control
        self.loop = loop
        self.budget = budget
        self.budgetRequest = budgetRequest
        self.proposals = proposals
        self.session = session
    }

    private enum CodingKeys: String, CodingKey { case control, loop, budget, budgetRequest, proposals, session }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        control = try container.decode(ShannonAutonomyControlDTO.self, forKey: .control)
        loop = try? container.decodeIfPresent(ShannonAutonomyLoopDTO.self, forKey: .loop)
        budget = try container.decode(ShannonAutonomyBudgetDTO.self, forKey: .budget)
        budgetRequest = try? container.decodeIfPresent(ShannonAutonomyBudgetRequestDTO.self, forKey: .budgetRequest)
        proposals = (try? container.decode(ShannonLossyList<ShannonAutonomyProposalDTO>.self, forKey: .proposals))?.items ?? []
        session = try? container.decodeIfPresent(Session.self, forKey: .session)
    }
}

/// What the page reads of `GET /v1/autonomy/study`: the stories that wait for the owner's reaction.
public struct ShannonNowStudyDTO: Decodable, Equatable, Sendable {
    public struct Piece: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
        /// Absent while she has not shown the piece.
        public let title: String?
        public let awaitingReaction: Bool

        public init(id: String, title: String? = nil, awaitingReaction: Bool) {
            self.id = id
            self.title = title
            self.awaitingReaction = awaitingReaction
        }

        private enum CodingKeys: String, CodingKey { case id, title, awaitingReaction }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            title = try? container.decodeIfPresent(String.self, forKey: .title)
            awaitingReaction = (try? container.decodeIfPresent(Bool.self, forKey: .awaitingReaction)) ?? false
        }
    }

    public let pieces: [Piece]

    public init(pieces: [Piece]) {
        self.pieces = pieces
    }

    private enum CodingKeys: String, CodingKey { case pieces }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pieces = (try? container.decode(ShannonLossyList<Piece>.self, forKey: .pieces))?.items ?? []
    }
}
