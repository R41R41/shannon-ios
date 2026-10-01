import Foundation

/// Date sections for the iPhone conversation list: 今日 / 昨日 / 今週 / それ以前.
enum ShannonThreadDateGroup: Int, CaseIterable, Comparable, Sendable {
    case today
    case yesterday
    case thisWeek
    case earlier

    var title: String {
        switch self {
        case .today: "今日"
        case .yesterday: "昨日"
        case .thisWeek: "今週"
        case .earlier: "それ以前"
        }
    }

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// Pure grouping, relative-time, and preview rules for the conversation list.
/// Inputs are injected (`now`, `calendar`) so the rules are deterministic in tests.
enum ShannonThreadDateGrouping {
    struct Section: Equatable, Identifiable {
        let group: ShannonThreadDateGroup
        let threads: [ChatThreadDTO]
        var id: Int { group.rawValue }
        var title: String { group.title }
    }

    /// Cached previews older than the thread's last update by more than this are treated as stale.
    static let previewStalenessTolerance: TimeInterval = 120
    static let previewCharacterLimit = 160

    static func date(from value: String) -> Date? {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return (try? fractional.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    }

    /// A date later than `now` (clock skew) counts as today; an unknown date counts as older.
    static func group(for date: Date?, now: Date, calendar: Calendar) -> ShannonThreadDateGroup {
        guard let date else { return .earlier }
        if date > now || calendar.isDate(date, inSameDayAs: now) { return .today }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return .yesterday
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) { return .thisWeek }
        return .earlier
    }

    /// Groups threads in section order while keeping the incoming order inside each section.
    static func sections(
        for threads: [ChatThreadDTO],
        now: Date,
        calendar: Calendar
    ) -> [Section] {
        var buckets: [ShannonThreadDateGroup: [ChatThreadDTO]] = [:]
        for thread in threads {
            let group = group(for: date(from: thread.updatedAt), now: now, calendar: calendar)
            buckets[group, default: []].append(thread)
        }
        return ShannonThreadDateGroup.allCases.compactMap { group in
            guard let threads = buckets[group], !threads.isEmpty else { return nil }
            return Section(group: group, threads: threads)
        }
    }

    /// 今日→HH:mm, 昨日→「昨日」, 今週→曜日, それ以前→M/d (another year adds the year).
    static func relativeLabel(for date: Date?, now: Date, calendar: Calendar) -> String {
        guard let date else { return "更新日時不明" }
        switch group(for: date, now: now, calendar: calendar) {
        case .today:
            return format(date, "HH:mm", calendar: calendar)
        case .yesterday:
            return "昨日"
        case .thisWeek:
            return format(date, "EEEE", calendar: calendar)
        case .earlier:
            var gregorian = Calendar(identifier: .gregorian)
            gregorian.timeZone = calendar.timeZone
            let sameYear = gregorian.component(.year, from: date) == gregorian.component(.year, from: now)
            return format(date, sameYear ? "M/d" : "yyyy/M/d", calendar: calendar)
        }
    }

    /// Plain one-paragraph preview of the last locally known message, or `nil` when the
    /// device has no message text that is at least as new as the thread's last update.
    static func preview(
        lastMessageText: String?,
        lastMessageDate: Date?,
        threadUpdatedAt: Date?
    ) -> String? {
        guard let lastMessageText, let lastMessageDate else { return nil }
        if let threadUpdatedAt,
           lastMessageDate < threadUpdatedAt.addingTimeInterval(-previewStalenessTolerance) {
            return nil
        }
        let plain = (try? AttributedString(
            markdown: lastMessageText,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )).map { String($0.characters) } ?? lastMessageText
        let collapsed = plain.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        return String(collapsed.prefix(previewCharacterLimit))
    }

    private static func format(_ date: Date, _ pattern: String, calendar: Calendar) -> String {
        // Grouping honours the user's calendar; labels always print Gregorian numbers.
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let formatter = DateFormatter()
        formatter.calendar = gregorian
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
}
