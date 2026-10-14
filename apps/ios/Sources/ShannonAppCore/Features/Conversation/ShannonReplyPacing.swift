import Foundation

/// Her text register and pacing (Syzygy ADR-0013 item 10, owner choice B 「形＋間と分け方」; `docs/feeling-events-contract.md`,
/// "Item 10"): `ChatResponse.textRegister` and the stream's `start.textRegister`. Absent from an older server or while the
/// switch is off, and then nothing changes. The words are the model's; the device only draws the pace.
public struct ShannonTextRegisterDTO: Codable, Equatable, Sendable {
    public var version: Int?
    /// Informational (the model was asked): `short` · `medium` · `free`, and characters (0 = no limit).
    public var length: String?
    public var maxCharacters: Int?
    public var punctuation: String?
    /// Informational. The device never adds an emoji, least of all to an error or a system notice.
    public var emoji: String?
    public var endings: String?
    public var lineBreaks: Bool?
    /// From his message being sent until her typing shows (0–20 000 ms; only what is left of it).
    public var pauseMs: Int?
    /// Her typing before her first message, at least (0–8 000 ms, from when it first showed).
    public var typingMs: Int?
    /// Two messages: the first sentence, then the rest (only when the reply has two sentences or more).
    public var split: Bool?
    /// Her typing between the two messages.
    public var gapMs: Int?
    /// The two messages, when the server split them.
    public var parts: [String]?
    /// `urgent` · `safety` · `promise` · `system`: the reply at once, whole.
    public var bypass: String?

    public init(
        version: Int? = 1, pauseMs: Int? = nil, typingMs: Int? = nil, split: Bool? = nil, gapMs: Int? = nil,
        parts: [String]? = nil, bypass: String? = nil
    ) {
        self.version = version
        self.pauseMs = pauseMs
        self.typingMs = typingMs
        self.split = split
        self.gapMs = gapMs
        self.parts = parts
        self.bypass = bypass
    }

    private enum CodingKeys: String, CodingKey {
        case version, length, maxCharacters, punctuation, emoji, endings, lineBreaks, pauseMs, typingMs, split, gapMs, parts, bypass
    }

    /// Never fails: a field of another shape is read as absent, so a reply is never lost to its pace.
    public init(from decoder: any Decoder) throws {
        guard let row = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        func value<T: Decodable>(_ key: CodingKeys) -> T? { (try? row.decodeIfPresent(T.self, forKey: key)) ?? nil }
        version = value(.version)
        length = value(.length)
        maxCharacters = value(.maxCharacters)
        punctuation = value(.punctuation)
        emoji = value(.emoji)
        endings = value(.endings)
        lineBreaks = value(.lineBreaks)
        pauseMs = value(.pauseMs)
        typingMs = value(.typingMs)
        split = value(.split)
        gapMs = value(.gapMs)
        parts = value(.parts)
        bypass = value(.bypass)
    }
}

/// How one reply is drawn: wait, show her typing, then one or two messages with her typing between them.
public struct ShannonReplyPacing: Equatable, Sendable {
    /// Before her typing shows (her typing is hidden meanwhile).
    public var pause: TimeInterval
    /// Her typing before the first message.
    public var typing: TimeInterval
    /// One message, or two.
    public var parts: [String]
    /// Her typing between the two.
    public var gap: TimeInterval

    public static let pauseCapMs = 20_000
    public static let typingCapMs = 8_000
    public static let gapCapMs = 8_000

    /// The reply at once, whole: an older server, the switch off, or a reply that must not wait.
    public static func immediate(_ reply: String) -> Self { .init(pause: 0, typing: 0, parts: [reply], gap: 0) }

    /// Whether anything is to be waited for or split.
    public var isImmediate: Bool { pause == 0 && typing == 0 && parts.count == 1 }

    /// The pace of `reply` sent at `sentAt`, read at `now`. Her typing has shown since `sentAt` unless a pause is still due.
    public static func plan(_ register: ShannonTextRegisterDTO?, reply: String, sentAt: Date, now: Date) -> Self {
        // Urgent, safety, promise and system notices are never delayed or split (and an unknown bypass is treated the same).
        guard let register, register.bypass == nil else { return .immediate(reply) }
        let elapsed = max(0, now.timeIntervalSince(sentAt))
        let pauseTotal = seconds(register.pauseMs, cap: pauseCapMs)
        let typingTotal = seconds(register.typingMs, cap: typingCapMs)
        let pause = max(0, pauseTotal - elapsed)
        // After a pause still due her typing starts afresh; otherwise it has shown since he sent.
        let typing = pause > 0 ? typingTotal : max(0, typingTotal - elapsed)
        let parts = register.split == true ? splitParts(register.parts, reply: reply) : [reply]
        return .init(pause: pause, typing: typing, parts: parts, gap: parts.count == 2 ? seconds(register.gapMs, cap: gapCapMs) : 0)
    }

    /// The two messages: the server's when it gave two, else the first sentence and the rest; one when there is one sentence.
    static func splitParts(_ given: [String]?, reply: String) -> [String] {
        if let given, given.count == 2, given.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return given
        }
        let ends: Set<Character> = ["。", "！", "？", "!", "?", "…"]
        // A sentence has words: leading marks (「……別に。」) belong to it.
        guard let words = reply.firstIndex(where: { !ends.contains($0) && !$0.isWhitespace }),
              let index = reply[words...].firstIndex(where: { ends.contains($0) }) else { return [reply] }
        // Closing marks that belong to the first sentence (「……」, 「！？」, a closing bracket).
        var cut = reply.index(after: index)
        while cut < reply.endIndex, ends.union(["」", "』", "）", ")"]).contains(reply[cut]) { cut = reply.index(after: cut) }
        let first = String(reply[..<cut]), rest = String(reply[cut...])
        guard !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [reply] }
        return [first, rest.trimmingCharacters(in: .whitespacesAndNewlines)]
    }

    private static func seconds(_ milliseconds: Int?, cap: Int) -> TimeInterval {
        TimeInterval(min(cap, max(0, milliseconds ?? 0))) / 1_000
    }
}

/// While a paced reply is drawn: whether her typing shows, for the Talk it belongs to.
public struct ShannonReplyPacingState: Equatable, Sendable {
    public let threadID: String?
    public var showsTyping: Bool
}
