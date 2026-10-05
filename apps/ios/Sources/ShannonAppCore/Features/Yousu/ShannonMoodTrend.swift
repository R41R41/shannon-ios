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
    /// The two windows the switch offers, in hours.
    public static let windows = [24, 168]

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
