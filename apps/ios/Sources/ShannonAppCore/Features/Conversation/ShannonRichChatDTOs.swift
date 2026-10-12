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

/// One message's reactions after a change, as the server holds them (oldest first).
public struct ShannonMessageReactionDTO: Codable, Equatable, Sendable {
    public let messageId: String
    public let emojis: [String]
}

public protocol ShannonReactionServing: Sendable {
    /// Turns one reaction on or off; a repeated request changes nothing more. `messageId` is the server's message id or,
    /// for her reply shown before the Talk was read back, its turn id.
    func changeReaction(scopeKey: String, threadId: String, messageId: String, emoji: String, on: Bool) async throws -> ShannonMessageReactionDTO
}
