import Foundation

/// The report card a finished piece of work the owner asked for leaves in its Talk (rich chat, `docs/rich-chat-contract.md`).
/// The server sends it only while the owner alone can see the screen and the work's sources are still his to see.
public struct ShannonReportCardDTO: Codable, Equatable, Sendable {
    public struct Finding: Codable, Equatable, Sendable {
        public let text: String
        public let sources: [Source]
    }
    public struct Source: Codable, Equatable, Sendable {
        public let title: String
        public let url: String

        public var webURL: URL? {
            guard let url = URL(string: url), url.scheme == "https" || url.scheme == "http", url.host != nil else { return nil }
            return url
        }
    }

    public let taskId: String
    public let reportId: String
    public let title: String
    /// `completed` or `failed`.
    public let status: String
    /// The short answer: the report's spoken form. Also the message's text.
    public let answer: String
    /// The full report, Markdown (tables, charts and images render as in a reply).
    public let report: String
    public let findings: [Finding]
    public var places: [ShannonPlaceDTO]? = nil
    public let reportedAt: String

    public var failed: Bool { status == "failed" }

    /// Every source once, in the order the findings name them.
    public var sources: [Source] {
        var seen = Set<String>()
        return findings.flatMap(\.sources).filter { seen.insert($0.url).inserted }
    }

    public var reportedDate: Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(reportedAt))
            ?? (try? Date.ISO8601FormatStyle().parse(reportedAt))
    }
}

/// One message's reactions after a change, as the server holds them (oldest first): the owner's, and hers (rich chat §4;
/// absent from older servers).
public struct ShannonMessageReactionDTO: Codable, Equatable, Sendable {
    public let messageId: String
    public let emojis: [String]
    public var shannonEmojis: [String]? = nil
}

/// Her reaction of a turn (rich chat §4, `shannonReaction` on the chat response): the emoji she put on the owner's message
/// that turn answered, and that message's server id.
public struct ShannonOwnReactionDTO: Codable, Equatable, Sendable {
    public let messageId: String
    public let emoji: String

    public init(messageId: String, emoji: String) {
        self.messageId = messageId
        self.emoji = emoji
    }
}

/// One emoji under a message as it is shown: how many put it on (the owner and she, Discord-style), and who.
public struct ShannonReactionChip: Equatable, Sendable {
    public let emoji: String
    public let mine: Bool
    public let hers: Bool
    public var count: Int { (mine ? 1 : 0) + (hers ? 1 : 0) }

    /// The owner's emoji in their order, then hers that he did not put on.
    public static func chips(mine: [String], hers: [String]) -> [ShannonReactionChip] {
        var seen = Set<String>()
        return (mine + hers).compactMap { emoji in
            guard seen.insert(emoji).inserted else { return nil }
            return ShannonReactionChip(emoji: emoji, mine: mine.contains(emoji), hers: hers.contains(emoji))
        }
    }

    /// 「ライ氏とシャノン」, 「シャノン」, 「ライ氏」: who put it on, for the chip's label.
    public var who: String {
        switch (mine, hers) {
        case (true, true): "ライ氏とシャノン"
        case (false, true): "シャノン"
        default: "ライ氏"
        }
    }
}

public protocol ShannonReactionServing: Sendable {
    /// Turns one reaction on or off; a repeated request changes nothing more. `messageId` is the server's message id or,
    /// for her reply shown before the Talk was read back, its turn id.
    func changeReaction(scopeKey: String, threadId: String, messageId: String, emoji: String, on: Bool) async throws -> ShannonMessageReactionDTO
}
