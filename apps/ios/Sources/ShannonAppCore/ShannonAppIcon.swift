import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public enum ShannonAppIconMode: String, CaseIterable, Identifiable, Sendable {
    case automatic
    case manual

    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .automatic: "シャノンに任せる"
        case .manual: "自分で選ぶ"
        }
    }
}

public enum ShannonAppIconChoice: String, CaseIterable, Identifiable, Sendable {
    case primary = "__primary__"
    case calm = "ShannonIconCalm"
    case joyful = "ShannonIconJoyful"
    case curious = "ShannonIconCurious"
    case sleepy = "ShannonIconSleepy"
    case exasperated = "ShannonIconExasperated"
    case excited = "ShannonIconExcited"
    case laughing = "ShannonIconLaughing"
    case tender = "ShannonIconTender"
    case bashful = "ShannonIconBashful"
    case determined = "ShannonIconDetermined"
    case sleeping = "ShannonIconSleeping"

    public static let emotionChoices: [Self] = [
        .calm, .joyful, .curious, .sleepy, .exasperated, .excited,
        .laughing, .tender, .bashful, .determined, .sleeping,
    ]

    public static let manualChoices: [Self] = [.primary] + emotionChoices

    public var id: String { rawValue }

    public var previewAssetName: String {
        switch self {
        case .primary: ShannonAppIconAssets.primaryLightPreviewAssetName
        default: "shannon-app-icon-preview-\(rawValue)"
        }
    }

    public var alternateIconName: String? {
        self == .primary ? nil : rawValue
    }

    public var japaneseName: String {
        switch self {
        case .primary: "デフォルト"
        case .calm: "穏やか"
        case .joyful: "うれしい"
        case .curious: "興味津々"
        case .sleepy: "眠そう"
        case .exasperated: "呆れている"
        case .excited: "わくわく"
        case .laughing: "爆笑"
        case .tender: "親愛"
        case .bashful: "照れ笑い"
        case .determined: "得意げ"
        case .sleeping: "眠っている"
        }
    }

    public var symbolName: String {
        switch self {
        case .primary: "app.fill"
        case .calm: "cup.and.saucer.fill"
        case .joyful: "hands.sparkles.fill"
        case .curious: "magnifyingglass"
        case .sleepy: "moon.zzz.fill"
        case .exasperated: "eyes"
        case .excited: "sparkles"
        case .laughing: "face.smiling.inverse"
        case .tender: "heart.fill"
        case .bashful: "hand.raised.fill"
        case .determined: "star.fill"
        case .sleeping: "moon.stars.fill"
        }
    }

    public static func matching(_ expression: ShannonExpressionDTO) -> ShannonAppIconChoice {
        switch expression {
        case .joyful:
            .joyful
        case .excited, .surprised:
            .excited
        case .amused, .laughing:
            .laughing
        case .bashful, .embarrassed:
            .bashful
        case .relieved, .calm, .neutral:
            .calm
        case .curious, .thinking, .confused:
            .curious
        case .determined:
            .determined
        case .tender:
            .tender
        case .sleepy, .sad, .concerned:
            .sleepy
        case .jealous, .wry, .exasperated, .annoyed:
            .exasperated
        }
    }
}

enum ShannonAppIconAssets {
    static let primaryLightPreviewAssetName = "shannon-app-icon-preview-primary"
    static let primaryDarkPreviewAssetName = "shannon-app-icon-preview-primary-dark"

    static func url(for assetName: String) -> URL? {
        Bundle.module.url(forResource: assetName, withExtension: "png")
    }

#if canImport(UIKit)
    static func uiImage(for assetName: String) -> UIImage? {
        guard let url = url(for: assetName) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }
#elseif canImport(AppKit)
    static func nsImage(for assetName: String) -> NSImage? {
        guard let url = url(for: assetName) else { return nil }
        return NSImage(contentsOf: url)
    }
#endif
}

enum ShannonAppIconTimeState: String, Equatable, Sendable {
    case sleeping
    case sleepy
    case daytime
}

struct ShannonAppIconDecision: Equatable, Sendable {
    let choice: ShannonAppIconChoice
    let timeState: ShannonAppIconTimeState
    let nextRefreshAt: Date
}

enum ShannonAppIconPolicy {
    static func decision(
        expression: ShannonExpressionDTO,
        now: Date,
        awakeUntil: Date?,
        calendar: Calendar = .current,
        randomRoll: Double,
        randomIndex: Int,
        recentDayChoices: [ShannonAppIconChoice]
    ) -> ShannonAppIconDecision {
        let hour = calendar.component(.hour, from: now)
        let boundary = nextTimeBoundary(after: now, calendar: calendar)

        if hour < 6 {
            if let awakeUntil, awakeUntil > now {
                return .init(
                    choice: .sleepy,
                    timeState: .sleepy,
                    nextRefreshAt: min(awakeUntil, boundary)
                )
            }
            return .init(choice: .sleeping, timeState: .sleeping, nextRefreshAt: boundary)
        }
        if hour < 7 || hour >= 23 {
            return .init(choice: .sleepy, timeState: .sleepy, nextRefreshAt: boundary)
        }
        return .init(
            choice: daytimeChoice(
                expression: expression,
                randomRoll: randomRoll,
                randomIndex: randomIndex,
                recentChoices: recentDayChoices
            ),
            timeState: .daytime,
            nextRefreshAt: boundary
        )
    }

    static func daytimeChoice(
        expression: ShannonExpressionDTO,
        randomRoll: Double,
        randomIndex: Int,
        recentChoices: [ShannonAppIconChoice]
    ) -> ShannonAppIconChoice {
        let matching = ShannonAppIconChoice.matching(expression)
        guard randomRoll >= 0.70 else { return matching }

        let compatible: [ShannonAppIconChoice]
        switch expression {
        case .sad, .concerned, .sleepy:
            compatible = [.calm, .tender, .curious]
        case .jealous, .wry, .exasperated, .annoyed:
            compatible = [.exasperated, .determined, .calm]
        case .thinking, .confused, .curious:
            compatible = [.curious, .calm, .determined]
        case .tender, .bashful, .embarrassed:
            compatible = [.tender, .bashful, .calm, .joyful]
        case .joyful, .excited, .amused, .laughing, .surprised:
            compatible = [.joyful, .excited, .laughing, .bashful, .curious]
        case .determined:
            compatible = [.determined, .excited, .calm]
        case .relieved, .calm, .neutral:
            compatible = [.calm, .curious, .tender, .joyful]
        }

        let fresh = compatible.filter { !recentChoices.suffix(2).contains($0) }
        let candidates = fresh.isEmpty ? compatible : fresh
        guard !candidates.isEmpty else { return matching }
        return candidates[abs(randomIndex) % candidates.count]
    }

    private static func nextTimeBoundary(after date: Date, calendar: Calendar) -> Date {
        let hour = calendar.component(.hour, from: date)
        let startOfDay = calendar.startOfDay(for: date)
        let targetHour: Int
        let dayOffset: Int
        switch hour {
        case 0..<6: (targetHour, dayOffset) = (6, 0)
        case 6: (targetHour, dayOffset) = (7, 0)
        case 7..<23: (targetHour, dayOffset) = (23, 0)
        default: (targetHour, dayOffset) = (0, 1)
        }
        let targetDay = calendar.date(byAdding: .day, value: dayOffset, to: startOfDay) ?? date
        return calendar.date(byAdding: .hour, value: targetHour, to: targetDay) ?? date.addingTimeInterval(60 * 60)
    }
}

@MainActor
@Observable
public final class ShannonAppIconModel {
    public private(set) var mode: ShannonAppIconMode
    public private(set) var manualChoice: ShannonAppIconChoice
    public private(set) var activeChoice: ShannonAppIconChoice?
    public private(set) var isUpdating = false
    public private(set) var errorMessage: String?
    public private(set) var nextRefreshAt: Date?

    private enum Keys {
        static let mode = "shannon.app-icon.mode"
        static let manualChoice = "shannon.app-icon.manual-choice"
        static let automaticCandidate = "shannon.app-icon.automatic-candidate"
        static let automaticCandidateSince = "shannon.app-icon.automatic-candidate-since"
        static let lastChangedAt = "shannon.app-icon.last-changed-at"
        static let lastTimeState = "shannon.app-icon.last-time-state"
        static let awakeUntil = "shannon.app-icon.awake-until"
        static let recentDayChoices = "shannon.app-icon.recent-day-choices"
    }

    private static let automaticChangeInterval: TimeInterval = 6 * 60 * 60

    public init() {
        let defaults = UserDefaults.standard
        let storedMode = defaults.string(forKey: Keys.mode)
        let storedChoice = defaults.string(forKey: Keys.manualChoice)
            .flatMap(ShannonAppIconChoice.init(rawValue:))
        if storedMode == "fixed" {
            mode = .manual
            manualChoice = .primary
            defaults.set(ShannonAppIconMode.manual.rawValue, forKey: Keys.mode)
            defaults.set(ShannonAppIconChoice.primary.rawValue, forKey: Keys.manualChoice)
        } else {
            mode = storedMode.flatMap(ShannonAppIconMode.init(rawValue:)) ?? .automatic
            manualChoice = storedChoice ?? .primary
        }
#if canImport(UIKit)
        activeChoice = UIApplication.shared.alternateIconName
            .flatMap(ShannonAppIconChoice.init(rawValue:))
#else
        activeChoice = nil
#endif
    }

    public var activeTitle: String {
        activeChoice?.japaneseName ?? ShannonAppIconChoice.primary.japaneseName
    }

    public func activate(
        for expression: ShannonExpressionDTO,
        now: Date = Date(),
        recordsLateNightUse: Bool = true
    ) async {
        refresh()
        switch mode {
        case .manual:
            await apply(choice: manualChoice, now: now)
        case .automatic:
            if recordsLateNightUse, Calendar.current.component(.hour, from: now) < 6 {
                UserDefaults.standard.set(now.addingTimeInterval(30 * 60), forKey: Keys.awakeUntil)
            }
            await updateAutomatically(for: expression, now: now)
        }
    }

    public func selectMode(
        _ newMode: ShannonAppIconMode,
        expression: ShannonExpressionDTO,
        now: Date = Date()
    ) async {
        mode = newMode
        UserDefaults.standard.set(newMode.rawValue, forKey: Keys.mode)
        switch newMode {
        case .manual:
            await apply(choice: manualChoice, now: now)
        case .automatic:
            await updateAutomatically(for: expression, now: now, force: true)
        }
    }

    public func selectManualChoice(_ choice: ShannonAppIconChoice, now: Date = Date()) async {
        manualChoice = choice
        UserDefaults.standard.set(choice.rawValue, forKey: Keys.manualChoice)
        guard mode == .manual else { return }
        await apply(choice: choice, now: now)
    }

    public func updateAutomatically(
        for expression: ShannonExpressionDTO,
        now: Date = Date(),
        force: Bool = false
    ) async {
        guard mode == .automatic else { return }
        let defaults = UserDefaults.standard
        let recentChoices = (defaults.stringArray(forKey: Keys.recentDayChoices) ?? [])
            .compactMap(ShannonAppIconChoice.init(rawValue:))
        let decision = ShannonAppIconPolicy.decision(
            expression: expression,
            now: now,
            awakeUntil: defaults.object(forKey: Keys.awakeUntil) as? Date,
            randomRoll: Double.random(in: 0..<1),
            randomIndex: Int.random(in: 0..<10_000),
            recentDayChoices: recentChoices
        )
        nextRefreshAt = decision.nextRefreshAt
        let previousTimeState = defaults.string(forKey: Keys.lastTimeState)
            .flatMap(ShannonAppIconTimeState.init(rawValue:))
        let crossedTimeBoundary = previousTimeState != decision.timeState
        defaults.set(decision.timeState.rawValue, forKey: Keys.lastTimeState)

        if decision.timeState != .daytime {
            guard force || crossedTimeBoundary || activeChoice != decision.choice else { return }
            await apply(choice: decision.choice, now: now)
            return
        }

        let choice = decision.choice

        if defaults.string(forKey: Keys.automaticCandidate) != choice.rawValue {
            defaults.set(choice.rawValue, forKey: Keys.automaticCandidate)
            defaults.set(now, forKey: Keys.automaticCandidateSince)
        }

        let candidateSince = defaults.object(forKey: Keys.automaticCandidateSince) as? Date ?? now
        let lastChangedAt = defaults.object(forKey: Keys.lastChangedAt) as? Date
        let stayedForSixHours = now.timeIntervalSince(candidateSince) >= Self.automaticChangeInterval
        let sixHoursSinceLastChange = lastChangedAt.map {
            now.timeIntervalSince($0) >= Self.automaticChangeInterval
        } ?? true

        guard force || crossedTimeBoundary || stayedForSixHours || sixHoursSinceLastChange else { return }
        await apply(choice: choice, now: now)
        var updatedRecent = recentChoices
        updatedRecent.append(choice)
        defaults.set(updatedRecent.suffix(2).map(\.rawValue), forKey: Keys.recentDayChoices)
    }

    public func dismissError() {
        errorMessage = nil
    }

    public func refresh() {
#if canImport(UIKit)
        activeChoice = UIApplication.shared.alternateIconName
            .flatMap(ShannonAppIconChoice.init(rawValue:))
#endif
    }

    private func apply(choice: ShannonAppIconChoice?, now: Date) async {
#if canImport(UIKit)
        guard UIApplication.shared.supportsAlternateIcons else {
            errorMessage = "この端末ではアイコンを切り替えられません。"
            return
        }
        let normalizedChoice = choice == .primary ? nil : choice
        let alternateIconName = normalizedChoice?.alternateIconName
        guard UIApplication.shared.alternateIconName != alternateIconName else {
            activeChoice = normalizedChoice
            return
        }

        isUpdating = true
        errorMessage = nil
        let failure: String? = await withCheckedContinuation { continuation in
            UIApplication.shared.setAlternateIconName(alternateIconName) { error in
                continuation.resume(returning: error?.localizedDescription)
            }
        }
        isUpdating = false
        if let failure {
            errorMessage = "アイコンを変更できませんでした: \(failure)"
            refresh()
            return
        }
        activeChoice = normalizedChoice
        UserDefaults.standard.set(now, forKey: Keys.lastChangedAt)
#else
        activeChoice = choice == .primary ? nil : choice
#endif
    }
}
