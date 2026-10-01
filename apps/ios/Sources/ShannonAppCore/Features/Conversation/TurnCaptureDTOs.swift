import Foundation

/// What Shannon took in from one turn. The server records it after the reply,
/// so it arrives later than the reply and may be absent on older servers.
public struct ShannonTurnCaptureDTO: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Equatable, Sendable {
        case commitment
        case knowledge
        case intent
        case notice

        /// A newer server may add kinds; an unknown one is shown as plain text, never a decoding failure.
        public init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .notice
        }
    }

    public let id: String
    public let kind: Kind
    public let text: String
    public let itemId: String?
    public let change: String?
    public let previousText: String?
    public let note: String?
    public let dueDate: String?
    public let dueAt: String?
    public let dueHint: String?
    public let timeZone: String?
    public let status: String?

    public init(
        id: String,
        kind: Kind,
        text: String,
        itemId: String? = nil,
        change: String? = nil,
        previousText: String? = nil,
        note: String? = nil,
        dueDate: String? = nil,
        dueAt: String? = nil,
        dueHint: String? = nil,
        timeZone: String? = nil,
        status: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.itemId = itemId
        self.change = change
        self.previousText = previousText
        self.note = note
        self.dueDate = dueDate
        self.dueAt = dueAt
        self.dueHint = dueHint
        self.timeZone = timeZone
        self.status = status
    }

    public var isCompleted: Bool { status == "completed" }
    /// A notice only tells the owner a limit; there is nothing stored to undo or open.
    public var canUndo: Bool { kind != .notice && itemId != nil && !isCompleted }
}

/// The promise a reminder message is about, with what the owner can still do.
public struct ShannonReminderDTO: Codable, Equatable, Sendable {
    public let commitmentId: String
    public let state: String
    public let text: String

    public init(commitmentId: String, state: String, text: String) {
        self.commitmentId = commitmentId
        self.state = state
        self.text = text
    }

    public var offersActions: Bool { state == "pending" }
}

public struct ShannonConversationCapturesDTO: Codable, Equatable, Sendable {
    public struct Turn: Codable, Equatable, Sendable {
        public let turnId: String
        public let captures: [ShannonTurnCaptureDTO]

        public init(turnId: String, captures: [ShannonTurnCaptureDTO]) {
            self.turnId = turnId
            self.captures = captures
        }
    }

    public struct Reminder: Codable, Equatable, Sendable {
        public let messageId: String
        public let commitmentId: String
        public let state: String
        public let text: String

        public init(messageId: String, commitmentId: String, state: String, text: String) {
            self.messageId = messageId
            self.commitmentId = commitmentId
            self.state = state
            self.text = text
        }
    }

    public let threadId: String
    public let turns: [Turn]
    public let reminders: [Reminder]

    public init(threadId: String, turns: [Turn] = [], reminders: [Reminder] = []) {
        self.threadId = threadId
        self.turns = turns
        self.reminders = reminders
    }
}

/// Owner-facing wording for a capture line. Kept free of SwiftUI so it is testable.
public enum ShannonTurnCapturePresentation {
    public static func title(_ capture: ShannonTurnCaptureDTO) -> String {
        switch capture.kind {
        case .commitment: capture.isCompleted ? "完了した約束" : "約束にしました"
        case .knowledge:
            switch capture.change {
            case "updated": "覚え直しました"
            case "confirmed": "覚えています"
            default: "覚えました"
            }
        case .intent: capture.isCompleted ? "完了した目的" : "目的にしました"
        case .notice: "お知らせ"
        }
    }

    public static func symbol(_ capture: ShannonTurnCaptureDTO) -> String {
        switch capture.kind {
        case .commitment: capture.isCompleted ? "checkmark.circle" : "calendar.badge.clock"
        case .knowledge: "bookmark"
        case .intent: "flag"
        case .notice: "info.circle"
        }
    }

    public static func line(
        _ capture: ShannonTurnCaptureDTO,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        if capture.kind == .notice { return capture.text }
        let due = dueLabel(capture, now: now, calendar: calendar)
        let body = [due, capture.text].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        let previous = capture.previousText.map { "（前は「\($0)」）" } ?? ""
        return "\(title(capture))：\(body)\(previous)"
    }

    public static func undoTitle(_ capture: ShannonTurnCaptureDTO) -> String {
        switch capture.kind {
        case .commitment: "この約束を取り消す"
        case .knowledge: "この記憶を忘れる"
        case .intent: "この目的を取り下げる"
        case .notice: "取り消す"
        }
    }

    public static func accessibilityLabel(
        _ capture: ShannonTurnCaptureDTO,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        [line(capture, now: now, calendar: calendar), capture.note].compactMap { $0 }.joined(separator: "。")
    }

    /// A stored date is shown relative to today, so 「明日」 never goes stale after a relaunch.
    public static func dueLabel(
        _ capture: ShannonTurnCaptureDTO,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String? {
        var local = calendar
        if let identifier = capture.timeZone, let zone = TimeZone(identifier: identifier) { local.timeZone = zone }
        if let dueAt = capture.dueAt, let date = parseInstant(dueAt) {
            let components = local.dateComponents([.hour, .minute], from: date)
            let minute = components.minute ?? 0
            let clock = minute == 0 ? "\(components.hour ?? 0)時" : "\(components.hour ?? 0)時\(minute)分"
            return "\(dayLabel(date, now: now, calendar: local)) \(clock)"
        }
        if let dueDate = capture.dueDate {
            let parts = dueDate.split(separator: "-").compactMap { Int($0) }
            if parts.count == 3,
               let date = local.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)) {
                return dayLabel(date, now: now, calendar: local)
            }
        }
        return capture.dueHint
    }

    private static func dayLabel(_ date: Date, now: Date, calendar: Calendar) -> String {
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)
        ).day ?? 0
        switch days {
        case 0: return "今日"
        case 1: return "明日"
        case 2: return "明後日"
        case -1: return "昨日"
        default:
            let parts = calendar.dateComponents([.month, .day], from: date)
            return "\(parts.month ?? 0)月\(parts.day ?? 0)日"
        }
    }

    private static func parseInstant(_ value: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}
