import Foundation

/// The words of 目標 and 点検: every value in words, a number never without its word (as 学び).
public enum ShannonExecutiveText {
    // MARK: Choices

    /// The chip of a choice's outcome; nil for a choice with nothing to report (a rest).
    public static func outcomeWord(_ outcome: String?) -> String? {
        switch outcome {
        case "pending": ShannonGeneratedStrings.executiveOutcomePending
        case "running": ShannonGeneratedStrings.executiveOutcomeRunning
        case "done": ShannonGeneratedStrings.executiveOutcomeDone
        case "failed": ShannonGeneratedStrings.executiveOutcomeFailed
        case "cancelled": ShannonGeneratedStrings.executiveOutcomeCancelled
        case "none", nil: nil
        default: ShannonGeneratedStrings.executiveOutcomeUnknown
        }
    }

    /// What was chosen: her words, else the capability's name.
    public static func choiceLabel(_ choice: ShannonChoicesDTO.Choice) -> String {
        choice.label ?? choice.capability ?? ShannonGeneratedStrings.executiveOutcomeUnknown
    }

    public static func choiceAccessibilityLabel(_ choice: ShannonChoicesDTO.Choice) -> String {
        var parts = [choice.at.map { ShannonYousuTime.clock($0) } ?? "", choiceLabel(choice)]
        if let goal = choice.goalTitle { parts.append(ShannonGeneratedStrings.executiveChoicesGoal(title: goal)) }
        if let reason = choice.reason { parts.append(reason) }
        if let outcome = outcomeWord(choice.outcome) { parts.append(outcome) }
        if choice.offCandidates == true { parts.append(ShannonGeneratedStrings.executiveChoicesOffCandidates) }
        return parts.filter { !$0.isEmpty }.joined(separator: "、")
    }

    // MARK: Goals

    public static func statusWord(_ status: String?) -> String {
        switch status {
        case "active": ShannonGeneratedStrings.autonomyPursuitStatusActive
        case "resting": ShannonGeneratedStrings.autonomyPursuitStatusResting
        case "done": ShannonGeneratedStrings.autonomyPursuitStatusDone
        case "dropped": ShannonGeneratedStrings.autonomyPursuitStatusDropped
        default: ShannonGeneratedStrings.executiveOutcomeUnknown
        }
    }

    /// 「3/5」 as the server words it, else 「60%」; nil without progress.
    public static func progressLabel(_ goal: ShannonGoalsDTO.Goal) -> String? {
        if let label = goal.progressLabel { return label }
        guard let progress = goal.progress else { return nil }
        return "\(Int((min(max(progress, 0), 1) * 100).rounded()))%"
    }

    /// 「10月16日」: the day of the next review.
    public static func day(_ iso: String, calendar: Calendar = .current) -> String {
        guard let date = ShannonYousuTime.date(iso) else { return ShannonGeneratedStrings.executiveOutcomeUnknown }
        return date.formatted(Date.FormatStyle(locale: Locale(identifier: "ja_JP"), calendar: calendar, timeZone: calendar.timeZone).month().day())
    }

    public static func title(_ goal: ShannonGoalsDTO.Goal) -> String {
        goal.title ?? ShannonGeneratedStrings.executiveGoalsUntitled
    }

    // MARK: Capabilities

    public static func policyWord(_ policy: String?) -> String? {
        switch policy {
        case "own_time": ShannonGeneratedStrings.executiveCapabilitiesPolicyOwnTime
        case "owner_request_only": ShannonGeneratedStrings.executiveCapabilitiesPolicyOwnerOnly
        case "off": ShannonGeneratedStrings.executiveCapabilitiesPolicyOff
        case nil: nil
        default: policy
        }
    }

    /// 「手応え +0.42±0.12（9回）・よい」, or 「手応え まだなし」.
    public static func valueLine(_ value: ShannonCapabilitiesDTO.Value?) -> String {
        guard let value, let mean = value.mean, let n = value.n, n > 0 else { return ShannonGeneratedStrings.executiveCapabilitiesValueNone }
        return ShannonGeneratedStrings.executiveCapabilitiesValue(
            value: ShannonLearning.signed(mean), sd: String(format: "%.2f", value.sd ?? 0), count: String(n),
            word: ShannonValueLevel(mean: mean, n: n).word
        )
    }

    public static func usesLine(_ capability: ShannonCapabilitiesDTO.Capability) -> String {
        let week = String(capability.uses7d ?? 0)
        guard let total = capability.usesTotal else { return ShannonGeneratedStrings.executiveCapabilitiesUsesWeek(count: week) }
        return ShannonGeneratedStrings.executiveCapabilitiesUses(week: week, total: String(total))
    }

    // MARK: Inspection

    /// One line of the counts: its name and how to read the value out of a day's counts.
    public struct CountRow: Identifiable, Sendable {
        public let id: String
        public let label: String
        public let value: @Sendable (ShannonInspectionDTO.Counts?) -> String
    }

    static let missing = "—"

    static func count(_ value: Int?) -> String { value.map(String.init) ?? missing }

    /// 「60%（6/10）」: the share of choices that took the candidate with the highest value.
    static func share(_ part: Int?, of total: Int?) -> String {
        guard let part, let total else { return missing }
        guard total > 0 else { return ShannonGeneratedStrings.executiveInspectionShare(percent: "0", part: "0", total: "0") }
        return ShannonGeneratedStrings.executiveInspectionShare(
            percent: String(Int((Double(part) / Double(total) * 100).rounded())), part: String(part), total: String(total)
        )
    }

    static func yen(_ value: Double?) -> String {
        value.map { ShannonGeneratedStrings.executiveInspectionYen(yen: String(Int($0.rounded()))) } ?? missing
    }

    /// The rows of 点検 (plan §6), in the order the owner reads them.
    public static let countRows: [CountRow] = [
        .init(id: "deliberations", label: ShannonGeneratedStrings.executiveInspectionDeliberations) { ShannonExecutiveText.count($0?.deliberations) },
        .init(id: "choices", label: ShannonGeneratedStrings.executiveInspectionChoices) { ShannonExecutiveText.count($0?.choices) },
        .init(id: "topValue", label: ShannonGeneratedStrings.executiveInspectionTopValue) { ShannonExecutiveText.share($0?.chosenTopValue, of: $0?.choices) },
        .init(id: "offCandidates", label: ShannonGeneratedStrings.executiveInspectionOffCandidates) { ShannonExecutiveText.count($0?.offCandidates) },
        .init(id: "capabilities", label: ShannonGeneratedStrings.executiveInspectionCapabilities) { ShannonExecutiveText.count($0?.distinctCapabilities) },
        .init(id: "goalsCompleted", label: ShannonGeneratedStrings.executiveInspectionGoalsCompleted) { ShannonExecutiveText.count($0?.goals?.completed) },
        .init(id: "goalsRested", label: ShannonGeneratedStrings.executiveInspectionGoalsRested) { ShannonExecutiveText.count($0?.goals?.rested) },
        .init(id: "goalsDropped", label: ShannonGeneratedStrings.executiveInspectionGoalsDropped) { ShannonExecutiveText.count($0?.goals?.dropped) },
        .init(id: "noticesSent", label: ShannonGeneratedStrings.executiveInspectionNoticesSent) { ShannonExecutiveText.count($0?.notices?.sent) },
        .init(id: "noticesAnswered", label: ShannonGeneratedStrings.executiveInspectionNoticesAnswered) { ShannonExecutiveText.count($0?.notices?.answered) },
        .init(id: "skillUses", label: ShannonGeneratedStrings.executiveInspectionSkillUses) { ShannonExecutiveText.count($0?.skillUses) },
        .init(id: "predictions", label: ShannonGeneratedStrings.executiveInspectionPredictions) { ShannonExecutiveText.share($0?.predictions?.hit, of: $0?.predictions?.made) },
        .init(id: "sleepRuns", label: ShannonGeneratedStrings.executiveInspectionSleepRuns) { ShannonExecutiveText.count($0?.sleepRuns) },
        .init(id: "unknown", label: ShannonGeneratedStrings.executiveInspectionUnknown) { ShannonExecutiveText.count($0?.unknown) },
        .init(id: "spent", label: ShannonGeneratedStrings.executiveInspectionSpent) { ShannonExecutiveText.yen($0?.spentYen) },
    ]
}
