import Foundation

public struct ShannonVoiceCallSummaryRequestDTO: Codable, Equatable, Sendable {
    public var timeZone: String = TimeZone.current.identifier
    public let scopeKey: String
    public let threadId: String?
    public let turns: [ShannonVoiceCallContextTurnDTO]

    public init(scopeKey: String, threadId: String?, turns: [ShannonVoiceCallContextTurnDTO]) {
        self.scopeKey = scopeKey
        self.threadId = threadId
        self.turns = turns
    }
}

public struct ShannonVoiceCallSummaryResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let messageId: String?
    public let summary: String
    public let observedAt: String?

    public init(threadId: String, messageId: String? = nil, summary: String, observedAt: String? = nil) {
        self.threadId = threadId
        self.messageId = messageId
        self.summary = summary
        self.observedAt = observedAt
    }
}

/// The note a 「友人も一緒」 call may leave in the owner's thread, and how the timeline recognises it.
public enum ShannonVoiceCallSummaryNote {
    public static let heading = "【友人も一緒の通話の要約】"
    public static let label = "通話の要約"

    public static func isNote(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(heading)
    }

    /// The note without its heading line, for a view that shows the label separately.
    public static func body(of text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(heading) else { return text }
        return String(trimmed.dropFirst(heading.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// What remains of an ended call until the owner answers 「この通話の要約をトークに残しますか？」.
/// It is held in memory only: declining, dismissing, a new call, or quitting the app discards it.
struct ShannonVoiceCallSummaryDraft: Equatable, Sendable {
    let threadID: String?
    let turns: [ShannonVoiceCallContextTurnDTO]
}

enum ShannonVoiceCallSummaryPromptState: Equatable, Sendable {
    case asking(ShannonVoiceCallSummaryDraft)
    case saving(ShannonVoiceCallSummaryDraft)
    case failed(ShannonVoiceCallSummaryDraft)
    case saved

    static let question = "この通話の要約をトークに残しますか？"

    var draft: ShannonVoiceCallSummaryDraft? {
        switch self {
        case let .asking(draft), let .saving(draft), let .failed(draft): draft
        case .saved: nil
        }
    }

    var detail: String {
        switch self {
        case .asking: "残すのは短い要約だけです。会話そのものは保存しません。選ばなければ何も残りません。"
        case .saving: "要約を作っています…"
        case .failed: "要約を残せませんでした。もう一度試すか、残さずに閉じられます。"
        case .saved: "要約をトークに残しました。"
        }
    }
}
