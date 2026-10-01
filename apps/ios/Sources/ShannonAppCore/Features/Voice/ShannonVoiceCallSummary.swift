import Foundation

/// What the server answers once a 「友人も一緒」 period has been remembered.
public struct ShannonRememberedVoiceCallDTO: Codable, Equatable, Sendable {
    public struct Person: Codable, Equatable, Sendable {
        public let id: String
        public let displayName: String

        public init(id: String, displayName: String) {
            self.id = id
            self.displayName = displayName
        }
    }

    public let callId: String
    public let status: String
    public let people: [Person]
    public let summary: String?

    public init(callId: String, status: String = "remembered", people: [Person] = [], summary: String? = nil) {
        self.callId = callId
        self.status = status
        self.people = people
        self.summary = summary
    }
}

struct ShannonVoiceRememberCallRequestDTO: Encodable {
    var timeZone: String = TimeZone.current.identifier
    let scopeKey: String
    let callId: String
    let threadId: String?
    let turns: [ShannonVoiceCallContextTurnDTO]
}

struct ShannonVoiceDiscardCallRequestDTO: Encodable {
    let scopeKey: String
    let callId: String
}

/// A note an earlier build could leave in the owner's thread. New calls are remembered under
/// 頭の中 › 人 instead; this only keeps old notes readable in the timeline.
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

/// The card shown in the call pill's place after a call that had a 「友人も一緒」 period. The call
/// is remembered by default; the card says so and offers 「今回は残さない」.
struct ShannonVoiceCallMemoryState: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        /// The device is still handing the period to the server.
        case remembering
        case remembered
        /// The server could not store it. Nothing was kept.
        case rememberFailed
        case discarding
        case discarded
        /// 「今回は残さない」 did not reach the server; the record still exists.
        case discardFailed
    }

    /// Every 「友人も一緒」 period of the ended call, in order.
    var callIDs: [String] = []
    /// Periods whose turns could not be stored yet, kept in memory only so they can be retried.
    var unsaved: [ShannonVoiceGuestPeriod] = []
    /// Names the server established from the words said, without duplicates.
    var names: [String] = []
    var phase: Phase = .remembering
    /// Periods still being sent.
    var pending = 0

    static let discardLabel = "今回は残さない"

    mutating func began(_ period: ShannonVoiceGuestPeriod) {
        if !callIDs.contains(period.callID) { callIDs.append(period.callID) }
        pending += 1
        if phase != .discarding && phase != .discarded { phase = .remembering }
    }

    mutating func finished(_ period: ShannonVoiceGuestPeriod, people: [String]?) {
        pending = max(0, pending - 1)
        unsaved.removeAll { $0.callID == period.callID }
        if let people {
            for name in people where !names.contains(name) { names.append(name) }
        } else {
            unsaved.append(period)
        }
        guard pending == 0, phase == .remembering || phase == .rememberFailed else { return }
        phase = unsaved.isEmpty ? .remembered : .rememberFailed
    }

    var title: String {
        switch phase {
        case .remembering: "この通話を覚えています…"
        case .remembered: "この通話を覚えました"
        case .rememberFailed: "この通話を覚えられませんでした"
        case .discarding: "この通話の記録を消しています…"
        case .discarded: "今回の通話は残しませんでした"
        case .discardFailed: "記録を消せませんでした"
        }
    }

    var detail: String {
        switch phase {
        case .remembering:
            "お名前と話したことを保存しています。"
        case .remembered:
            names.isEmpty
                ? "お名前は聞いていないので、話したことだけを覚えました。ライ氏と二人の時にだけ使います。頭の中の「人」で確認できます。"
                : "\(names.map { "\($0)さん" }.joined(separator: "・"))のお名前と、話したことを覚えました。頭の中の「人」で確認できます。"
        case .rememberFailed:
            "接続を確認して、もう一度お試しください。このままでは何も残りません。"
        case .discarding:
            "少しお待ちください。"
        case .discarded:
            "この通話で聞いたお名前と会話は残っていません。"
        case .discardFailed:
            "この通話の記録はまだ残っています。もう一度お試しください。"
        }
    }

    var symbol: String {
        switch phase {
        case .remembering, .discarding: "person.2"
        case .remembered: "person.2.fill"
        case .rememberFailed, .discardFailed: "exclamationmark.bubble"
        case .discarded: "checkmark.circle"
        }
    }
}
