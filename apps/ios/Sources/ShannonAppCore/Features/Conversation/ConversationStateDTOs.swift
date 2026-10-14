import Foundation

public struct ShannonTemperamentDTO: Codable, Equatable, Sendable {
    public let curiosity: Double
    public let initiative: Double
    public let closeness: Double
    public let calmness: Double
    public let needForContinuity: Double
    public let confidenceAboutUser: Double
}

public struct ShannonEmotionDTO: Codable, Equatable, Sendable {
    public let valence: Double
    public let arousal: Double
    public let openness: Double
}

public enum ShannonExpressionDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case joyful
    case excited
    case amused
    case laughing
    case bashful
    case embarrassed
    case relieved
    case surprised
    case curious
    case thinking
    case confused
    case determined
    case tender
    case calm
    case jealous
    case wry
    case exasperated
    case annoyed
    case concerned
    case sad
    case sleepy
    case neutral
}

public extension ShannonExpressionDTO {
    /// The feeling kind the server adds in body stage 1b (気持ち悪い・いや, Syzygy ADR-0005). It has no face of its own:
    /// it shows the `annoyed` face, as the server and the Live2D page also show it.
    static let uncomfortableName = "uncomfortable"

    /// A face this build knows by this name: one of the 22, or `annoyed` for `uncomfortable`; nil for any other name.
    static func known(_ name: String) -> Self? {
        Self(rawValue: name) ?? (name == uncomfortableName ? .annoyed : nil)
    }

    /// A face name from a newer server never fails a reply, a message, a mood or her presence: `uncomfortable` is
    /// `annoyed`, and any other name this build does not know is the usual face.
    init(from decoder: any Decoder) throws {
        self = Self.known(try decoder.singleValueContainer().decode(String.self)) ?? .neutral
    }
}

public struct ShannonMessageEmotionDTO: Codable, Equatable, Sendable {
    public let valence: Double
    public let arousal: Double
    public let openness: Double
    public let expression: ShannonExpressionDTO
    /// Name of a core feeling that borrows `expression`'s face. Kept as text so an
    /// unknown value from a newer server never fails decoding; read it through `face`.
    public var feeling: String? = nil
    /// The reply's own emotion kind (`SHANNON_EMOTION_KINDS`), absent from servers before 2026-10-05 and when
    /// the face comes from the quiet mood. Text, read through `face`: an unknown name shows the face.
    public var kind: String? = nil
    /// The face the reply was shown with (Syzygy ADR-0013 D17, `SHANNON_SINGLE_FACE`): one id of the server's presentation
    /// vocabulary, already the public layer's when anyone else was there. Absent from older servers; read it through
    /// `ShannonPresentationFace`, which shows the usual face without it and the neutral face for an id it does not know.
    public var presentationId: String? = nil
}

extension ShannonMessageEmotionDTO {
    private enum CodingKeys: String, CodingKey {
        case valence, arousal, openness, expression, feeling, kind, presentationId
    }

    /// `feeling` and `kind` are optional names: a value that is not text is read as absent, never as a failed reply.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        valence = try container.decode(Double.self, forKey: .valence)
        arousal = try container.decode(Double.self, forKey: .arousal)
        openness = try container.decode(Double.self, forKey: .openness)
        expression = try container.decode(ShannonExpressionDTO.self, forKey: .expression)
        feeling = (try? container.decodeIfPresent(String.self, forKey: .feeling)) ?? nil
        kind = (try? container.decodeIfPresent(String.self, forKey: .kind)) ?? nil
        presentationId = (try? container.decodeIfPresent(String.self, forKey: .presentationId)) ?? nil
    }
}

public struct UserFactDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let statement: String
    public let confidence: Double
    public let observedAt: String
    public let evidence: String?
}

public struct ActiveMemoryDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let summary: String
    public let relevance: Double
    public let observedAt: String
}

public struct CompanionStateDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let version: Int
    public let updatedAt: String
    public let temperament: ShannonTemperamentDTO
    public let emotion: ShannonEmotionDTO
    public let interests: [String]
    public let userFacts: [UserFactDTO]
    public let activeMemories: [ActiveMemoryDTO]
    /// Absent from servers that predate the presented state.
    public var presence: CompanionPresenceDTO? = nil
}

public struct ChatRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let message: String
    public let threadId: String?
    public let attachments: [ShannonChatAttachmentDTO]?
    public let webSearch: Bool?
    public let placeLocation: ShannonVoiceDeviceLocationDTO?
    /// What this app's camera can do in this turn; absent on a client that never looks.
    public var appLook: ShannonAppLookClientStateDTO? = nil
    /// `"sentences"` asks for the reply as NDJSON sentence by sentence (docs/chat-stream-contract.md); absent: one JSON document.
    public var stream: String? = nil

    /// The one value of `stream` the contract defines.
    public static let sentenceStream = "sentences"

    public init(
        scopeKey: String,
        message: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO] = [],
        webSearch: Bool = false,
        placeLocation: ShannonVoiceDeviceLocationDTO? = nil
    ) {
        self.scopeKey = scopeKey
        self.message = message
        self.threadId = threadId
        self.attachments = attachments.isEmpty ? nil : attachments
        self.webSearch = webSearch ? true : nil
        self.placeLocation = placeLocation
    }
}

public struct ShannonChatAttachmentDTO: Codable, Equatable, Sendable {
    public let name: String
    public let mimeType: String
    public let text: String

    public init(name: String, mimeType: String, text: String) {
        self.name = name
        self.mimeType = mimeType
        self.text = text
    }
}

public struct ShannonGeneratedArtifactDTO: Codable, Equatable, Sendable {
    public let name: String
    public let mimeType: String
    public let content: String
    public let summary: String?

    public init(name: String, mimeType: String, content: String, summary: String? = nil) {
        self.name = name
        self.mimeType = mimeType
        self.content = content
        self.summary = summary
    }
}

public struct ChatThreadDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let messageCount: Int
    public let summary: String?
    public let sections: [String]?

    public init(
        threadId: String,
        title: String,
        createdAt: String,
        updatedAt: String,
        messageCount: Int,
        summary: String? = nil,
        sections: [String]? = nil
    ) {
        self.threadId = threadId
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messageCount = messageCount
        self.summary = summary
        self.sections = sections
    }
}

public struct ShannonUIBlockDTO: Codable, Equatable, Sendable {
    public let type: String
    public let proposalId: String?
    public let cognitiveIntentID: String?
    public let title: String?
    public let goal: String?
    public let hostHint: String?
    public let projectHint: String?
    public let risk: String?
    public let session: ShannonOrganizeSessionDTO?
    public let places: [ShannonPlaceDTO]?

    public init(
        type: String = "agent_task_proposal",
        proposalId: String? = nil,
        cognitiveIntentID: String? = nil,
        title: String? = nil,
        goal: String? = nil,
        hostHint: String? = nil,
        projectHint: String? = nil,
        risk: String? = nil,
        session: ShannonOrganizeSessionDTO? = nil,
        places: [ShannonPlaceDTO]? = nil
    ) {
        self.type = type
        self.proposalId = proposalId
        self.cognitiveIntentID = cognitiveIntentID
        self.title = title
        self.goal = goal
        self.hostHint = hostHint
        self.projectHint = projectHint
        self.risk = risk
        self.session = session
        self.places = places
    }
}

public struct ShannonPlaceDTO: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let address: String
    public let reason: String
    public let mapQuery: String
    public let mapUrl: String

    public var id: String { mapUrl }

    public init(name: String, address: String, reason: String, mapQuery: String, mapUrl: String) {
        self.name = name
        self.address = address
        self.reason = reason
        self.mapQuery = mapQuery
        self.mapUrl = mapUrl
    }
}
