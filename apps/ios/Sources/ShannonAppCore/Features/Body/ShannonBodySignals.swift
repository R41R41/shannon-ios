import Foundation

/// What Shannon is doing in her own time, in the body contract's vocabulary. The server gives
/// it to her desktop body in `GET /v1/body/presence`; the app must not read that route (a read
/// is how the server knows a body's window is showing), so it is derived here from what the
/// owner's app already reads: the activity loop's state and the activity record.
public enum ShannonBodyDoing: String, CaseIterable, Equatable, Sendable {
    case idle, thinking, reading, noting, drafting, revising, showing

    /// A neutral status line; nil while she is doing nothing of her own.
    public var japaneseLine: String? {
        switch self {
        case .idle: nil
        case .thinking: "考えごとをしています"
        case .reading: "読んでいます"
        case .noting: "メモを書いています"
        case .drafting: "物語を書いています"
        case .revising: "物語を直しています"
        case .showing: "見せる準備をしています"
        }
    }
}

public enum ShannonBodySignals {
    /// The server's own table (`shannonBody.ts`, `STEP_DOING`).
    static let stepDoing: [String: ShannonBodyDoing] = [
        "study.think": .thinking, "study.read": .reading, "study.notion": .reading, "study.note": .noting,
        "study.draft": .drafting, "study.revise": .revising, "study.ready": .showing, "study.show": .showing,
    ]
    /// A step is shown for this long after its record, as on the server.
    static let doingFreshSeconds: TimeInterval = 3 * 60

    /// Her latest own step while the loop runs, otherwise idle. The app's copy of the record is as
    /// fresh as its last read, so this lags the desktop body by up to one refresh.
    public static func doing(loopState: String?, days: [ShannonAutonomyActivityDayDTO], now: Date) -> ShannonBodyDoing {
        guard loopState == "running" else { return .idle }
        let steps = days.flatMap(\.entries).filter { entry in
            entry.actor == "shannon" && (entry.tool?.hasPrefix("study.") ?? false)
                && (entry.kind == "action" || (entry.kind == "decision" && entry.outcome == "allowed"))
        }
        guard let latest = steps.compactMap({ entry in date(entry.occurredAt).map { (entry, $0) } }).max(by: { $0.1 < $1.1 }) else { return .idle }
        let age = now.timeIntervalSince(latest.1)
        guard age >= 0, age <= doingFreshSeconds else { return .idle }
        return stepDoing[latest.0.tool ?? ""] ?? .idle
    }

    /// `setPresence`. `/v1/state` carries the presented face but neither the conversational emotion's
    /// name nor its strength, so a lingering feeling is shown at a middle strength.
    public static func presence(state: CompanionStateDTO?, doing: ShannonBodyDoing, awaitingReaction: Int) -> ShannonLive2DPresence {
        let mood = state?.presence?.mood
        let lingers = mood?.fromConversation == true
        return ShannonLive2DPresence(
            expression: lingers ? mood?.expression.rawValue : nil,
            feeling: lingers ? mood?.feeling : nil,
            intensity: lingers ? 0.5 : 0,
            doing: doing.rawValue,
            awaitingReaction: max(0, awaitingReaction)
        )
    }

    /// One phase for the page. A running call decides; otherwise a pending text reply is thinking.
    public static func phase(isSendingText: Bool, call: ShannonDialogueActivity?) -> ShannonLive2DPhase {
        if let call, call != .idle { return ShannonLive2DPhase(call) }
        return isSendingText ? .thinking : .idle
    }

    /// What she is doing, as one quiet phrase for the body screen.
    public static func doingLine(phase: ShannonLive2DPhase, doing: ShannonBodyDoing, awaitingReaction: Int) -> String? {
        switch phase {
        case .thinking: return "返事を考えています"
        case .listening: return "聞いています"
        case .speaking: return "話しています"
        case .idle: break
        }
        if let line = doing.japaneseLine { return line }
        return awaitingReaction > 0 ? "物語の感想を待っています" : nil
    }

    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
