import Foundation

/// `GET /v1/shannon/mood-history` (`docs/mood-history-contract.md`): her continuous mood over
/// the last hours, oldest first. Only the owner's paired device may read it.
public struct ShannonMoodHistoryDTO: Decodable, Equatable, Sendable {
    public struct Point: Decodable, Equatable, Sendable {
        public struct Mood: Decodable, Equatable, Sendable {
            public let expression: String
            public let feeling: String?
        }

        public struct Present: Decodable, Equatable, Sendable {
            public let kind: String
            public let intensity: Double
        }

        public let at: String
        public let valence: Double
        public let arousal: Double
        public let openness: Double
        public let mood: Mood?
        public let present: Present?
    }

    public let schemaVersion: Int?
    public let generatedAt: String?
    public let hours: Int?
    public let points: [Point]
    /// The newest point before the window, which still holds at its start (absent on older servers).
    public let carryIn: Point?
    public let downsampled: Bool?

    public init(schemaVersion: Int?, generatedAt: String?, hours: Int?, points: [Point], carryIn: Point? = nil, downsampled: Bool?) {
        self.schemaVersion = schemaVersion
        self.generatedAt = generatedAt
        self.hours = hours
        self.points = points
        self.carryIn = carryIn
        self.downsampled = downsampled
    }

    /// Whether there is anything to draw: points in the window, or a mood carried in from before it.
    public var hasMood: Bool { !points.isEmpty || carryIn != nil }
}

/// The three lines of 「気分の推移」, as the owner named them (2026-10-05).
public enum ShannonMoodLine: String, CaseIterable, Identifiable, Sendable {
    case valence, arousal, openness

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .valence: ShannonGeneratedStrings.yousuMoodTrendLineValence
        case .arousal: ShannonGeneratedStrings.yousuMoodTrendLineArousal
        case .openness: ShannonGeneratedStrings.yousuMoodTrendLineOpenness
        }
    }

    /// Where the value rests when nothing moves it (`SHANNON_MOOD_BASELINE` in `@shannon/cognition`).
    /// The chart and the words show each line as how far it is from there.
    public var baseline: Double {
        switch self {
        case .valence: 0
        case .arousal: 0.30
        case .openness: 0.35
        }
    }

    public func value(_ point: ShannonMoodHistoryDTO.Point) -> Double {
        switch self {
        case .valence: point.valence
        case .arousal: point.arousal
        case .openness: point.openness
        }
    }

    /// How far from the resting value, kept within −1…1.
    public func deviation(_ point: ShannonMoodHistoryDTO.Point) -> Double {
        min(1, max(-1, value(point) - baseline))
    }
}

/// 明るめ（気分の明るさ）・高め（元気さ、心の開き）／ふつう／低め.
public enum ShannonMoodLevel: Equatable, Sendable {
    case high, normal, low

    /// About ±0.2 from the resting value.
    public static let threshold = 0.2

    public init(deviation: Double) {
        if deviation >= Self.threshold { self = .high } else if deviation <= -Self.threshold { self = .low } else { self = .normal }
    }

    public func word(for line: ShannonMoodLine) -> String {
        switch self {
        case .high: line == .valence ? ShannonGeneratedStrings.yousuMoodTrendLevelBright : ShannonGeneratedStrings.yousuMoodTrendLevelHigh
        case .normal: ShannonGeneratedStrings.yousuMoodTrendLevelNormal
        case .low: ShannonGeneratedStrings.yousuMoodTrendLevelLow
        }
    }
}

/// One step of a line: the value holds from `start` until `end` (the next point, or now).
public struct ShannonMoodStep: Equatable, Sendable {
    public let start: Date
    public let end: Date
    public let value: Double
}

public enum ShannonMoodTrend {
    /// The three windows the switch offers, in hours (1時間／24時間／7日; owner decision 2026-10-06).
    public static let windows = [1, 24, 168]

    /// How long one drawn step is at least, by window: 1 minute in an hour, 5 minutes in a day,
    /// 30 minutes in a week. Points written seconds apart would otherwise draw spikes.
    public static func bucket(hours: Int) -> TimeInterval {
        switch hours {
        case ...1: 60
        case ...24: 5 * 60
        default: 30 * 60
        }
    }

    /// Steps as drawn: the steps are collapsed into buckets counted from the window's start, the
    /// last step in each bucket is kept and placed at the bucket's start, and each holds until the
    /// next kept one (the newest until the end of the last step, now). The value carried in at the
    /// window's start is the first bucket's first step, so it stays there unless a point of the
    /// window's first bucket replaces it. The words and the summary still read the true newest point.
    public static func bucketed(_ steps: [ShannonMoodStep], windowStart: Date, bucket: TimeInterval) -> [ShannonMoodStep] {
        guard bucket > 0, let final = steps.last else { return steps }
        var kept: [(index: Int, value: Double)] = []
        for step in steps {
            let index = max(0, Int((step.start.timeIntervalSince(windowStart) / bucket).rounded(.down)))
            if let last = kept.last, last.index == index { kept[kept.count - 1].value = step.value } else { kept.append((index, step.value)) }
        }
        let starts = kept.map { windowStart.addingTimeInterval(Double($0.index) * bucket) }
        return kept.enumerated().map { offset, entry in
            let end = offset + 1 < kept.count ? starts[offset + 1] : max(final.end, starts[offset])
            return ShannonMoodStep(start: starts[offset], end: end, value: entry.value)
        }
    }

    /// The quarter hours of the clock inside the window (「20:15」, 「20:30」…), for the hour's
    /// time marks: counted from the window's start they would fall on odd minutes.
    public static func quarterHours(from start: Date, to end: Date, timeZone: TimeZone = .current) -> [Date] {
        let step: TimeInterval = 15 * 60
        let offset = Double(timeZone.secondsFromGMT(for: start))
        var mark = Date(timeIntervalSince1970: ((start.timeIntervalSince1970 + offset) / step).rounded(.up) * step - offset)
        var marks: [Date] = []
        while mark <= end {
            marks.append(mark)
            mark = mark.addingTimeInterval(step)
        }
        return marks
    }

    /// The vertical reach of the rows, the same for all three: ±0.6, or the largest distance from
    /// rest in the window rounded up to 0.1 when that is larger, never beyond ±1.
    public static func yLimit(_ points: [ShannonMoodHistoryDTO.Point], carryIn: ShannonMoodHistoryDTO.Point? = nil) -> Double {
        let all = points + (carryIn.map { [$0] } ?? [])
        let largest = all.flatMap { point in ShannonMoodLine.allCases.map { abs($0.deviation(point)) } }.max() ?? 0
        // The values are rounded to 0.01, so a hair below the next tenth is that tenth.
        let rounded = (largest * 10 - 1e-6).rounded(.up) / 10
        return min(1, max(0.6, rounded))
    }

    /// The part of the window before anything was recorded: from the window's start to the first
    /// point, when no value was carried in from before the window. Nil when there is no such part.
    public static func unrecorded(
        _ points: [ShannonMoodHistoryDTO.Point], carryIn: ShannonMoodHistoryDTO.Point? = nil, windowStart: Date
    ) -> Range<Date>? {
        guard carryIn == nil, let first = points.compactMap({ ShannonYousuTime.date($0.at) }).min(), first > windowStart
        else { return nil }
        return windowStart..<first
    }

    /// The end of the window: the server's `generatedAt`, or the time of the read when it has none.
    public static func windowEnd(_ history: ShannonMoodHistoryDTO, readAt: Date) -> Date {
        history.generatedAt.flatMap(ShannonYousuTime.date) ?? readAt
    }

    /// A line as steps. The server records a point only when something changes, and while she
    /// is dormant her mood is kept, not absent: so each point holds until the next one, and a
    /// long gap is drawn as unchanged, never cut. The point carried in holds from the window's
    /// start. Points that cannot be read are skipped.
    public static func steps(
        _ line: ShannonMoodLine, points: [ShannonMoodHistoryDTO.Point], carryIn: ShannonMoodHistoryDTO.Point? = nil,
        windowStart: Date? = nil, until now: Date
    ) -> [ShannonMoodStep] {
        var dated = points.compactMap { point in ShannonYousuTime.date(point.at).map { ($0, line.deviation(point)) } }
            .sorted { $0.0 < $1.0 }
        if let carryIn, let carried = ShannonYousuTime.date(carryIn.at) {
            let start = max(carried, windowStart ?? carried)
            if dated.first.map({ $0.0 > start }) ?? true { dated.insert((start, line.deviation(carryIn)), at: 0) }
        }
        return dated.enumerated().compactMap { index, entry in
            let end = index + 1 < dated.count ? dated[index + 1].0 : max(now, entry.0)
            return ShannonMoodStep(start: entry.0, end: end, value: entry.1)
        }
    }

    /// The words of the newest point of each line (the one carried in when the window has none), or nil.
    public static func latestLevels(_ points: [ShannonMoodHistoryDTO.Point], carryIn: ShannonMoodHistoryDTO.Point? = nil) -> [ShannonMoodLine: ShannonMoodLevel]? {
        guard let latest = points.max(by: { (ShannonYousuTime.date($0.at) ?? .distantPast) < (ShannonYousuTime.date($1.at) ?? .distantPast) }) ?? carryIn
        else { return nil }
        return Dictionary(uniqueKeysWithValues: ShannonMoodLine.allCases.map { ($0, ShannonMoodLevel(deviation: $0.deviation(latest))) })
    }

    /// 「気分の明るさは明るめ、元気さはふつう、心の開きは低め」 for VoiceOver. No numbers.
    public static func summary(_ points: [ShannonMoodHistoryDTO.Point], carryIn: ShannonMoodHistoryDTO.Point? = nil) -> String? {
        guard let levels = latestLevels(points, carryIn: carryIn),
              let valence = levels[.valence], let arousal = levels[.arousal], let openness = levels[.openness]
        else { return nil }
        return ShannonGeneratedStrings.yousuMoodTrendSummary(
            valence: valence.word(for: .valence), arousal: arousal.word(for: .arousal), openness: openness.word(for: .openness)
        )
    }
}

/// What the three rows draw for one answer, computed once when the answer arrives (not on every
/// layout pass): the window, the shared reach, the part before the record, each line's drawn steps,
/// and the words and summary of the true newest point.
public struct ShannonMoodTrendDrawing: Equatable, Sendable {
    public let start: Date
    public let now: Date
    public let limit: Double
    public let unrecorded: Range<Date>?
    public let steps: [ShannonMoodLine: [ShannonMoodStep]]
    public let levels: [ShannonMoodLine: ShannonMoodLevel]?
    public let summary: String?

    public init(history: ShannonMoodHistoryDTO, hours: Int, readAt: Date) {
        // The window ends at the server's own time, so a device whose clock is off draws it right.
        let end = ShannonMoodTrend.windowEnd(history, readAt: readAt)
        let windowStart = end.addingTimeInterval(-Double(hours) * 3600)
        now = end
        start = windowStart
        limit = ShannonMoodTrend.yLimit(history.points, carryIn: history.carryIn)
        unrecorded = ShannonMoodTrend.unrecorded(history.points, carryIn: history.carryIn, windowStart: windowStart)
        steps = Dictionary(uniqueKeysWithValues: ShannonMoodLine.allCases.map { line in
            (line, ShannonMoodTrend.bucketed(
                ShannonMoodTrend.steps(line, points: history.points, carryIn: history.carryIn, windowStart: windowStart, until: end),
                windowStart: windowStart, bucket: ShannonMoodTrend.bucket(hours: hours)
            ))
        })
        levels = ShannonMoodTrend.latestLevels(history.points, carryIn: history.carryIn)
        summary = ShannonMoodTrend.summary(history.points, carryIn: history.carryIn)
    }

    /// Where the band of 「ふつう」 starts: after the part before anything was recorded.
    public var recordStart: Date { unrecorded?.upperBound ?? start }

    /// The share of the window's width before the record (0 when there is none).
    public var unrecordedShare: Double {
        guard let unrecorded else { return 0 }
        let window = now.timeIntervalSince(start)
        return window > 0 ? unrecorded.upperBound.timeIntervalSince(unrecorded.lowerBound) / window : 0
    }
}
