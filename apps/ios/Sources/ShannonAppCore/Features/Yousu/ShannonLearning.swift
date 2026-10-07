import Foundation

/// The three pages of 「ようす」 (Syzygy ADR-0008 §13, option A, owner 2026-10-07): いま／学び／気分.
public enum ShannonYousuTab: String, CaseIterable, Identifiable, Sendable {
    case now, learning, mood

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .now: ShannonGeneratedStrings.yousuTabNow
        case .learning: ShannonGeneratedStrings.yousuTabLearning
        case .mood: ShannonGeneratedStrings.yousuTabMood
        }
    }
}

/// 手応え in words: what a cell of her value table holds, never as a bare number. The number stays beside its word, as in the
/// value facts of her thinking (`packages/learning/src/valueFacts.ts`).
public enum ShannonValueLevel: Equatable, Sendable {
    case good, fair, poor
    /// Fewer than three settled choices: the coordinator's warm-up, too few to say.
    case few

    public static let warmUp = 3

    public init(mean: Double, n: Int) {
        if n < Self.warmUp { self = .few } else if mean >= 0.5 { self = .good } else if mean >= 0.2 { self = .fair } else { self = .poor }
    }

    public var word: String {
        switch self {
        case .good: ShannonGeneratedStrings.yousuLearningValuesLevelGood
        case .fair: ShannonGeneratedStrings.yousuLearningValuesLevelFair
        case .poor: ShannonGeneratedStrings.yousuLearningValuesLevelPoor
        case .few: ShannonGeneratedStrings.yousuLearningValuesLevelFew
        }
    }
}

/// One line of 手応え: the choice in words, its value and the word for it, and how many times it was settled.
public struct ShannonValueLine: Equatable, Identifiable, Sendable {
    public let choice: String
    public let label: String
    public let mean: Double
    public let n: Int
    public let level: ShannonValueLevel
    public let lastAt: Date

    public var id: String { choice }

    /// 「+0.53」, the sign always written, as in the value facts.
    public var value: String { ShannonLearning.signed(mean) }

    public var accessibilityLabel: String {
        ShannonGeneratedStrings.yousuLearningValuesRowAccessibility(
            label: label, word: level.word, value: ShannonLearning.spokenSigned(mean), count: String(n)
        )
    }
}

public enum ShannonLearning {
    /// 手応え lists what was settled in the last seven days (the mock's 「最近7日」), at most eight lines (as the value facts).
    public static let recentDays = 7
    public static let recentLimit = 8

    /// How each choice is named: the same names as the value facts of her thinking (`valueFacts.ts`, `VALUE_FACT_KINDS`),
    /// and the conversation's choices (`tier.*`, `skill.use`; `docs/skill-and-routing-contract.md`).
    static let choiceLabels: [String: String] = {
        let reasons = [("share", "面白かったことを伝えたい"), ("wonder", "いま何をしているか気になった"), ("upcoming", "近い予定が気になった"), ("saw", "見たことを話したい")]
        var labels: [String: String] = [:]
        for (reason, label) in reasons {
            labels["reach_out.\(reason)"] = "話しかける・\(label)"
            labels["call.\(reason)"] = "電話をかける・\(label)"
        }
        let fixed: [(String, String)] = [
            ("follow_up", "もう一度話しかける"), ("show", "物語を見せる"), ("draft", "物語の下書きを書く"), ("revise", "物語を直す"),
            ("put_away", "作品をしまう"), ("read", "公開ページを読む"), ("notion", "Notionを読む"), ("note", "メモを書く"),
            ("jot", "書き留める"), ("copy", "フォルダに写す"), ("look", "部屋を見る"), ("skill.use", "スキルを使う"),
            ("tier.luna", "会話で、ふつうに考えて返す"), ("tier.luna_plus", "会話で、よく考えて返す"), ("tier.sonnet", "会話で、強いモデルで返す"),
        ]
        for (choice, label) in fixed { labels[choice] = label }
        return labels
    }()

    public static func choiceLabel(_ choice: String) -> String {
        if let label = choiceLabels[choice] { return label }
        if choice.hasPrefix("tool.") { return "道具「\(choice.dropFirst("tool.".count))」を使う" }
        return choice
    }

    /// The lines of 手応え: one per choice (the cell of the choice as a whole, not of a moment), settled at least once, the
    /// newest first, within the last seven days of `now`.
    public static func recentLines(_ cells: [ShannonValuesDTO.Cell], now: Date) -> [ShannonValueLine] {
        let since = now.addingTimeInterval(-Double(recentDays) * 24 * 3600)
        return cells
            .filter { $0.level == "choice" && $0.n >= 1 }
            .compactMap { cell -> ShannonValueLine? in
                guard let lastAt = cell.lastAt.flatMap(ShannonYousuTime.date), lastAt >= since else { return nil }
                return ShannonValueLine(
                    choice: cell.choice, label: choiceLabel(cell.choice), mean: cell.mean, n: cell.n,
                    level: ShannonValueLevel(mean: cell.mean, n: cell.n), lastAt: lastAt
                )
            }
            .sorted { $0.lastAt != $1.lastAt ? $0.lastAt > $1.lastAt : $0.choice < $1.choice }
            .prefix(recentLimit)
            .map { $0 }
    }

    static func signed(_ value: Double) -> String {
        let magnitude = String(format: "%.2f", abs(value))
        return value < 0 && magnitude != "0.00" ? "−\(magnitude)" : "+\(magnitude)"
    }

    /// 「プラス0.53」: VoiceOver reads 「−」 inconsistently.
    static func spokenSigned(_ value: Double) -> String {
        let magnitude = String(format: "%.2f", abs(value))
        return value < 0 && magnitude != "0.00" ? "マイナス\(magnitude)" : "プラス\(magnitude)"
    }

    // MARK: Skills

    /// 「成功 7/8」, 「試用中 2/3」, or 「まだ使っていません」.
    public static func skillLine(_ skill: ShannonSkillDTO) -> String {
        if skill.isRetired { return retiredReason(skill) }
        if let trial = skill.trial { return ShannonGeneratedStrings.yousuLearningSkillsTrial(uses: String(trial.uses), of: String(trial.of)) }
        if skill.uses == 0 { return ShannonGeneratedStrings.yousuLearningSkillsUnused }
        return ShannonGeneratedStrings.yousuLearningSkillsSuccess(successes: String(skill.successes), uses: String(skill.uses))
    }

    /// Why a skill was retired, in words (`statusReason`, `docs/skill-and-routing-contract.md`).
    public static func retiredReason(_ skill: ShannonSkillDTO) -> String {
        switch skill.statusReason {
        case "trial_failed": ShannonGeneratedStrings.yousuLearningSkillsRetiredTrialFailed
        case "low_success": ShannonGeneratedStrings.yousuLearningSkillsRetiredLowSuccess
        case "consolidated": ShannonGeneratedStrings.yousuLearningSkillsRetiredConsolidated
        case "source_forgotten": ShannonGeneratedStrings.yousuLearningSkillsRetiredSourceForgotten
        case "restore_unsafe": ShannonGeneratedStrings.yousuLearningSkillsRetiredRestoreUnsafe
        default: ShannonGeneratedStrings.yousuLearningSkillsRetiredOther
        }
    }

    /// What a row says to VoiceOver: the title, its line, and whether it is pinned or the owner's version.
    public static func skillAccessibilityLabel(_ skill: ShannonSkillDTO) -> String {
        var parts = [skill.description, skillLine(skill)]
        if skill.ownerVersion { parts.append(ShannonGeneratedStrings.yousuLearningSkillsOwnerVersion) }
        if skill.pinned { parts.append(ShannonGeneratedStrings.yousuLearningSkillsPinned) }
        return parts.joined(separator: "、")
    }

    /// Who made a version of a skill, in words.
    public static func actorWord(_ actor: String) -> String {
        switch actor {
        case "sleep": ShannonGeneratedStrings.yousuLearningSkillActorSleep
        case "conversation": ShannonGeneratedStrings.yousuLearningSkillActorConversation
        case "owner": ShannonGeneratedStrings.yousuLearningSkillActorOwner
        case "shannon_copy": ShannonGeneratedStrings.yousuLearningSkillActorShannonCopy
        default: actor
        }
    }

    // MARK: The value table's version

    public static func makerWord(_ madeBy: String) -> String {
        switch madeBy {
        case "owner_rollback": ShannonGeneratedStrings.yousuLearningVersionMakerOwnerRollback
        case "owner_resume": ShannonGeneratedStrings.yousuLearningVersionMakerOwnerResume
        default: ShannonGeneratedStrings.yousuLearningVersionMakerSleep
        }
    }

    /// The version 「前の版に戻す」 goes back to, as the server chooses it without a `versionId` (`rollbackTarget` in
    /// `packages/learning/src/versions.ts`): the newest version that learned from less than the active one. The app sends
    /// its id, so the confirmation names the version that is restored. Nil when there is none.
    public static func rollbackTarget(_ values: ShannonValuesDTO) -> ShannonValuesDTO.Version? {
        guard let active = values.active else { return nil }
        return values.versions
            .filter { $0.versionId != active.versionId && $0.evidenceTo < active.evidenceTo }
            .sorted { $0.evidenceTo != $1.evidenceTo ? $0.evidenceTo > $1.evidenceTo : $0.createdAt > $1.createdAt }
            .first
    }

    /// How many settled results a version learned from.
    public static func evidenceCount(_ version: ShannonValuesDTO.Version) -> Int {
        version.evidenceTo >= version.evidenceFrom && version.evidenceTo > 0 ? version.evidenceTo - max(1, version.evidenceFrom) + 1 : 0
    }
}
