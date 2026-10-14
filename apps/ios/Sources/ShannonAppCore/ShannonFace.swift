import Foundation

/// A core character feeling that has no artwork of its own. The server sends
/// the closest existing face in `expression` and the feeling here, so the face
/// stays valid while the name says what Shannon actually feels.
public enum ShannonFeelingDTO: String, CaseIterable, Equatable, Sendable {
    case proud
    case flustered
    case apologetic
}

/// What the owner sees of Shannon's feeling: one of the 22 faces plus, for the
/// borrowed ones, the feeling's own name, and the reply's own kind when it has an
/// icon (2026-10-05). iPhone and Mac read every name from here; no screen keeps its
/// own table.
public struct ShannonFace: Equatable, Sendable {
    public let expression: ShannonExpressionDTO
    public let feeling: ShannonFeelingDTO?
    /// The reply's own feeling when this build shows an icon for it; nil shows the face icon.
    public let kind: ShannonEmotionKindIcon?

    /// A kind whose picture is not in this build's bundle is dropped, so every way of making a face shows
    /// the face icon and its name for it, never an empty picture.
    public init(expression: ShannonExpressionDTO, feeling: ShannonFeelingDTO? = nil, kind: ShannonEmotionKindIcon? = nil) {
        self.init(expression: expression, feeling: feeling, kind: kind, bundled: ShannonEmotionKindIcon.bundled)
    }

    init(expression: ShannonExpressionDTO, feeling: ShannonFeelingDTO?, kind: ShannonEmotionKindIcon?, bundled: Set<ShannonEmotionKindIcon>) {
        self.expression = expression
        self.feeling = feeling
        self.kind = kind.flatMap { bundled.contains($0) ? $0 : nil }
    }

    /// An unknown feeling name from a newer server falls back to the face's own name; an unknown
    /// kind, or one whose icon is not bundled, falls back to the face.
    /// The kind `uncomfortable` (body stage 1b) has no icon: it shows the `annoyed` face and its icon.
    public init(expression: ShannonExpressionDTO, feelingName: String?, kindName: String? = nil) {
        self.init(
            expression: kindName == ShannonExpressionDTO.uncomfortableName ? .annoyed : expression,
            feeling: feelingName.flatMap(ShannonFeelingDTO.init(rawValue:)),
            kind: ShannonEmotionKindIcon.displayed(kindName)
        )
    }

    /// The name of what the icon shows: the kind's while its icon is shown, else the face's.
    public var japaneseName: String {
        kind?.japaneseName ?? feeling?.japaneseName ?? expression.japaneseName
    }

    /// Reads as 「シャノン、得意げ」. The name is not followed by 「表情」: several names
    /// already end in a noun, and 「いつもの表情表情」 was the result.
    public var accessibilityDescription: String {
        "シャノン、\(japaneseName)"
    }
}

public extension ShannonFeelingDTO {
    var japaneseName: String {
        switch self {
        case .proud: "得意げ"
        case .flustered: "慌てている"
        case .apologetic: "申し訳なさそう"
        }
    }
}

public extension ShannonExpressionDTO {
    /// The single table of expression names for iPhone, Mac, labels and VoiceOver.
    var japaneseName: String {
        switch self {
        case .joyful: "うれしい"
        case .excited: "わくわく"
        case .amused: "楽しそう"
        case .laughing: "爆笑"
        case .bashful: "照れ笑い"
        case .embarrassed: "照れている"
        case .relieved: "ほっとしている"
        case .surprised: "びっくり"
        case .curious: "興味津々"
        case .thinking: "考え中"
        case .confused: "困惑している"
        case .determined: "やる気"
        case .tender: "やさしい"
        case .calm: "穏やか"
        case .jealous: "やきもち"
        case .wry: "苦笑い"
        case .exasperated: "呆れている"
        case .annoyed: "むっとしている"
        case .concerned: "心配"
        case .sad: "かなしい"
        case .sleepy: "眠そう"
        case .neutral: "ふだんどおり"
        }
    }

    var accessibilityDescription: String {
        ShannonFace(expression: self).accessibilityDescription
    }
}

public extension ShannonMessageEmotionDTO {
    var face: ShannonFace { ShannonFace(expression: expression, feelingName: feeling, kindName: kind) }
}

public extension ConversationMessage.EmotionSnapshot {
    init(_ emotion: ShannonMessageEmotionDTO, stateVersion: Int) {
        self.init(
            valence: emotion.valence,
            arousal: emotion.arousal,
            openness: emotion.openness,
            expression: emotion.expression,
            feeling: emotion.face.feeling,
            kind: emotion.kind,
            presentationId: emotion.presentationId,
            stateVersion: stateVersion
        )
    }

    var face: ShannonFace {
        ShannonFace(
            expression: kind == ShannonExpressionDTO.uncomfortableName ? .annoyed : expression, feeling: feeling,
            kind: ShannonEmotionKindIcon.displayed(kind))
    }
}

/// 「いま」 as the server presents it at read time: the conversational feeling
/// through the carry-over rule, and what the trait values are made of.
public struct CompanionPresenceDTO: Codable, Equatable, Sendable {
    public struct Mood: Codable, Equatable, Sendable {
        public let expression: ShannonExpressionDTO
        public let feeling: String?
        public let cause: String
        public let fromConversation: Bool

        public init(expression: ShannonExpressionDTO, feeling: String? = nil, cause: String, fromConversation: Bool) {
            self.expression = expression
            self.feeling = feeling
            self.cause = cause
            self.fromConversation = fromConversation
        }

        public var face: ShannonFace { ShannonFace(expression: expression, feelingName: feeling) }
    }

    public struct TemperamentReasons: Codable, Equatable, Sendable {
        public let closeness: String
        public let curiosity: String
        public let confidenceAboutUser: String

        public init(closeness: String, curiosity: String, confidenceAboutUser: String) {
            self.closeness = closeness
            self.curiosity = curiosity
            self.confidenceAboutUser = confidenceAboutUser
        }
    }

    public let mood: Mood
    public let temperamentReasons: TemperamentReasons

    public init(mood: Mood, temperamentReasons: TemperamentReasons) {
        self.mood = mood
        self.temperamentReasons = temperamentReasons
    }
}
