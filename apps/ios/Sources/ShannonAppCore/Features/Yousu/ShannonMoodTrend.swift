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
    public let downsampled: Bool?
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

/// 明るめ／ふつう／低め: the same three words for every line.
public enum ShannonMoodLevel: Equatable, Sendable {
    case high, normal, low

    /// About ±0.2 from the resting value.
    public static let threshold = 0.2

    public init(deviation: Double) {
        if deviation >= Self.threshold { self = .high } else if deviation <= -Self.threshold { self = .low } else { self = .normal }
    }

    public var word: String {
        switch self {
        case .high: ShannonGeneratedStrings.yousuMoodTrendLevelHigh
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

    /// A line as steps. The server records a point only when something changes, and while she
    /// is dormant her mood is kept, not absent: so each point holds until the next one, and a
    /// long gap is drawn as unchanged, never cut. Points that cannot be read are skipped.
    public static func steps(_ line: ShannonMoodLine, points: [ShannonMoodHistoryDTO.Point], until now: Date) -> [ShannonMoodStep] {
        let dated = points.compactMap { point in ShannonYousuTime.date(point.at).map { ($0, line.deviation(point)) } }
            .sorted { $0.0 < $1.0 }
        return dated.enumerated().compactMap { index, entry in
            let end = index + 1 < dated.count ? dated[index + 1].0 : max(now, entry.0)
            return ShannonMoodStep(start: entry.0, end: end, value: entry.1)
        }
    }

    /// The words of the newest point of each line, or nil when there is none.
    public static func latestLevels(_ points: [ShannonMoodHistoryDTO.Point]) -> [ShannonMoodLine: ShannonMoodLevel]? {
        guard let latest = points.max(by: { (ShannonYousuTime.date($0.at) ?? .distantPast) < (ShannonYousuTime.date($1.at) ?? .distantPast) })
        else { return nil }
        return Dictionary(uniqueKeysWithValues: ShannonMoodLine.allCases.map { ($0, ShannonMoodLevel(deviation: $0.deviation(latest))) })
    }

    /// 「気分の明るさは明るめ、元気さはふつう、心の開きは低め」 for VoiceOver. No numbers.
    public static func summary(_ points: [ShannonMoodHistoryDTO.Point]) -> String? {
        guard let levels = latestLevels(points),
              let valence = levels[.valence], let arousal = levels[.arousal], let openness = levels[.openness]
        else { return nil }
        return ShannonGeneratedStrings.yousuMoodTrendSummary(valence: valence.word, arousal: arousal.word, openness: openness.word)
    }
}
