import Foundation

/// Shannon's study (書斎) as the owner sees it: the notes and stories she writes in
/// her own time. The text is hers; the owner reads what she is willing to show,
/// leaves a reaction, or asks her to put a piece away.

/// What the activity loop is doing, in the words the server chose.
public struct ShannonAutonomyLoopDTO: Codable, Equatable, Sendable {
    /// `preparing`, `running`, `paused`, or `budget_exhausted`.
    public let state: String
    public let label: String
    public let heartbeatAt: String?

    public init(state: String, label: String, heartbeatAt: String? = nil) {
        self.state = state
        self.label = label
        self.heartbeatAt = heartbeatAt
    }

    public var detail: String {
        switch state {
        case "running":
            "シャノンは、決められた範囲と予算の中で、自分から調べたり書いたりしています。したことは記録に残ります。"
        case "paused":
            "シャノンは自分からは何もしません。会話・音声・記憶・あなたが始めた作業は、これまでどおり動きます。"
        case "budget_exhausted":
            "今日の予算を使い切ったので、お金のかかることは明日まで止まっています。"
        default:
            "自分から動く仕組みは、まだ動いていません。サーバーで有効にし、専用のAPIキーを設定すると動き始めます。"
        }
    }

    public var symbolName: String {
        switch state {
        case "running": "play.circle"
        case "paused": "pause.circle"
        case "budget_exhausted": "yensign.circle"
        default: "moon.zzz"
        }
    }
}

/// A message that tells the owner about a piece carries this; the card opens the reader.
public struct ShannonStudyPieceLinkDTO: Codable, Equatable, Sendable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

public struct ShannonStudyPieceCardDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    /// `story` or `note`.
    public let kind: String
    public let kindLabel: String
    /// `draft`, `ready`, `shown`, or `put_away`.
    public let status: String
    public let statusLabel: String
    /// True while she has nothing she is willing to show: no title, no text.
    public let hidden: Bool
    public let title: String?
    public let excerpt: String?
    public let version: Int?
    public let revising: Bool
    public let updatedAt: String

    public init(
        id: String, kind: String, kindLabel: String, status: String, statusLabel: String, hidden: Bool,
        title: String? = nil, excerpt: String? = nil, version: Int? = nil, revising: Bool = false, updatedAt: String
    ) {
        self.id = id
        self.kind = kind
        self.kindLabel = kindLabel
        self.status = status
        self.statusLabel = statusLabel
        self.hidden = hidden
        self.title = title
        self.excerpt = excerpt
        self.version = version
        self.revising = revising
        self.updatedAt = updatedAt
    }

    public var isStory: Bool { kind == "story" }
    public var isPutAway: Bool { status == "put_away" }

    /// A piece she has not shown yet has no title for the owner.
    public var displayTitle: String {
        if let title, !hidden { return title }
        return isPutAway ? "しまったものがあります" : "作っているものがあります"
    }

    public var symbolName: String {
        if hidden { return "lock.doc" }
        return isStory ? "book.closed" : "note.text"
    }

    public var statusLine: String {
        var parts = [kindLabel, statusLabel]
        if let version, isStory, !hidden { parts.append("第\(version)稿") }
        return parts.joined(separator: " ・ ")
    }
}

public struct ShannonStudySourceDTO: Codable, Equatable, Sendable {
    public let title: String
    public let url: String
}

public struct ShannonStudyVersionNoteDTO: Codable, Equatable, Identifiable, Sendable {
    public let version: Int
    public let changeNote: String
    public let createdAt: String

    public var id: Int { version }
}

public struct ShannonStudyFeedbackDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let version: Int
    public let reaction: String
    public let reactionLabel: String
    public let comment: String
    public let createdAt: String
    /// She has been given this reaction in a revising step.
    public let used: Bool

    public var statusLabel: String { used ? "シャノンが直す時に読みました" : "次に直す時に渡します" }
}

public struct ShannonStudyPieceDetailDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let kindLabel: String
    public let status: String
    public let statusLabel: String
    public let hidden: Bool
    public let title: String?
    public let excerpt: String?
    public let version: Int?
    public let revising: Bool
    public let updatedAt: String
    public let body: String?
    public let sources: [ShannonStudySourceDTO]
    public let versions: [ShannonStudyVersionNoteDTO]
    public let feedback: [ShannonStudyFeedbackDTO]
    public let canReact: Bool
    public let canPutAway: Bool

    public var card: ShannonStudyPieceCardDTO {
        ShannonStudyPieceCardDTO(
            id: id, kind: kind, kindLabel: kindLabel, status: status, statusLabel: statusLabel, hidden: hidden,
            title: title, excerpt: excerpt, version: version, revising: revising, updatedAt: updatedAt
        )
    }
}

public struct ShannonStudyReactionChoiceDTO: Codable, Equatable, Identifiable, Sendable {
    /// `like`, `more`, or `unclear`.
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }

    public var symbolName: String {
        switch id {
        case "like": "heart"
        case "more": "plus.circle"
        default: "questionmark.circle"
        }
    }

    /// Used until the server's list has loaded.
    public static let standard = [
        ShannonStudyReactionChoiceDTO(id: "like", label: "好き"),
        ShannonStudyReactionChoiceDTO(id: "more", label: "もう少し"),
        ShannonStudyReactionChoiceDTO(id: "unclear", label: "よく分からない"),
    ]
}

public struct ShannonStudyOverviewDTO: Codable, Equatable, Sendable {
    public let pieces: [ShannonStudyPieceCardDTO]
    public let reactions: [ShannonStudyReactionChoiceDTO]

    public init(pieces: [ShannonStudyPieceCardDTO], reactions: [ShannonStudyReactionChoiceDTO] = ShannonStudyReactionChoiceDTO.standard) {
        self.pieces = pieces
        self.reactions = reactions
    }
}

struct ShannonStudyReactionRequestDTO: Codable, Equatable, Sendable {
    let scopeKey: String
    let reaction: String
    let comment: String?
}

struct ShannonStudyScopeRequestDTO: Codable, Equatable, Sendable {
    let scopeKey: String
}

public enum ShannonStudyLimits {
    /// The server accepts a comment of at most this many characters.
    public static let comment = 400
}
