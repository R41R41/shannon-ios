import SwiftUI

/// 「ようす › 目標」 (Syzygy ADR-0009 stage 2, E7; owner 2026-10-13, comparison page §5 option A): what she chose lately with
/// her one-line reason, then her goals with their condition, progress and next review, and the owner's 「完了を認める」
/// 「休める」「やめる」 (each asked once more before it is sent). Shared by the iPhone and the Mac (ADR-0004).
struct ShannonGoalsView: View {
    @Bindable var model: ShannonExecutiveModel

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var pending: Pending?

    /// A control waiting for the owner's second yes.
    struct Pending: Identifiable, Equatable {
        let goal: ShannonGoalsDTO.Goal
        let action: ShannonExecutiveModel.GoalAction
        var id: String { "\(goal.id)|\(action)" }
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if let notice = model.goalNotice {
                Section {
                    Label(notice, systemImage: "exclamationmark.triangle")
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.onAttentionTint)
                        .listRowBackground(palette.attentionTint)
                }
            }
            choicesSection(palette: palette)
            goalsSection(palette: palette)
        }
        .overlay {
            if model.goals == nil, model.choices == nil, model.isLoadingGoals {
                ProgressView(ShannonGeneratedStrings.yousuLoading)
            }
        }
        .refreshable { await model.reloadGoals() }
        // Read when the tab appears and when the app comes back to the front; never in the background.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.reloadGoals()
        }
        .confirmationDialog(
            pending.map(Self.confirmTitle) ?? "",
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            titleVisibility: .visible,
            presenting: pending
        ) { pending in
            Button(Self.actionTitle(pending.action), role: pending.action == .drop ? .destructive : nil) {
                Task { await model.perform(pending.action, on: pending.goal) }
            }
            Button(ShannonGeneratedStrings.yousuLearningCancel, role: .cancel) {}
        } message: { pending in
            Text(Self.confirmMessage(pending.action))
        }
    }

    // MARK: 最近えらんだこと

    @ViewBuilder
    private func choicesSection(palette: ShannonPalette) -> some View {
        let choices = model.recentChoices
        Section {
            if model.choices == nil {
                phaseLine(model.choicesPhase, palette: palette)
            } else if choices.isEmpty {
                quietLine(ShannonGeneratedStrings.executiveChoicesEmpty, palette: palette)
            } else {
                ForEach(choices) { choice in
                    choiceRow(choice, palette: palette)
                }
            }
        } header: {
            Text(ShannonGeneratedStrings.executiveChoicesTitle)
        }
    }

    private func choiceRow(_ choice: ShannonChoicesDTO.Choice, palette: ShannonPalette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Text(choice.at.map { ShannonYousuTime.clock($0) } ?? "")
                .font(.shannon(.footnote).weight(.medium))
                .monospacedDigit()
                .foregroundStyle(palette.action)
                .frame(minWidth: 44, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                    Text(ShannonExecutiveText.choiceLabel(choice))
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if let outcome = ShannonExecutiveText.outcomeWord(choice.outcome) {
                        ShannonExecutiveChip(text: outcome, palette: palette)
                    }
                }
                if let reason = choice.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let goal = choice.goalTitle {
                    Text(ShannonGeneratedStrings.executiveChoicesGoal(title: goal))
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ShannonExecutiveText.choiceAccessibilityLabel(choice))
        .accessibilityAddTraits(.isStaticText)
    }

    // MARK: 目標

    @ViewBuilder
    private func goalsSection(palette: ShannonPalette) -> some View {
        let open = model.openGoals
        let closed = model.closedGoals
        Section {
            if model.goals == nil {
                phaseLine(model.goalsPhase, palette: palette)
            } else if open.isEmpty {
                quietLine(ShannonGeneratedStrings.executiveGoalsEmpty, palette: palette)
            } else {
                ForEach(open) { goal in
                    goalRow(goal, palette: palette)
                }
            }
            if !closed.isEmpty {
                DisclosureGroup {
                    ForEach(closed) { goal in
                        goalRow(goal, palette: palette)
                    }
                } label: {
                    Text(ShannonGeneratedStrings.executiveGoalsClosedTitle(count: String(closed.count)))
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)
                }
            }
            if model.goals != nil, model.goalsPhase == .unreadable {
                Text(ShannonGeneratedStrings.executiveUnreadable)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }
        } header: {
            if let limit = model.goals?.activeLimit {
                Text(ShannonGeneratedStrings.executiveGoalsTitle(active: String(open.filter(\.isActive).count), limit: String(limit)))
            } else {
                Text(ShannonGeneratedStrings.executiveGoalsHeading)
            }
        } footer: {
            if model.goals != nil { Text(ShannonGeneratedStrings.executiveGoalsFooter) }
        }
    }

    private func goalRow(_ goal: ShannonGoalsDTO.Goal, palette: ShannonPalette) -> some View {
        let sending = model.goalsInFlight.contains(goal.id)
        return VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                    Text(ShannonExecutiveText.title(goal))
                        .font(.shannon(.body).weight(.semibold))
                        .foregroundStyle(goal.isActive ? palette.textPrimary : palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if !goal.isActive { ShannonExecutiveChip(text: ShannonExecutiveText.statusWord(goal.status), palette: palette) }
                }
                if let why = goal.why, !why.isEmpty {
                    Text(why)
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                conditionLine(goal, palette: palette)
                if let progress = goal.progress, goal.isOpen {
                    ProgressView(value: min(max(progress, 0), 1))
                        .tint(palette.action)
                        .accessibilityHidden(true)
                }
                metaLine(goal, palette: palette)
                if let reason = goal.closedReason, !reason.isEmpty, !goal.isActive {
                    Text(ShannonGeneratedStrings.executiveGoalsClosedReason(reason: reason))
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            if goal.canConfirm || goal.canRest || goal.canDrop {
                HStack(spacing: ShannonSpacing.medium) {
                    if goal.canConfirm { controlButton(.confirm, goal: goal, color: palette.action) }
                    if goal.canRest { controlButton(.rest, goal: goal, color: palette.action) }
                    if goal.canDrop { controlButton(.drop, goal: goal, color: palette.danger) }
                    if sending {
                        Spacer(minLength: 0)
                        ProgressView()
                    }
                }
                .disabled(sending)
            }
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
    }

    @ViewBuilder
    private func conditionLine(_ goal: ShannonGoalsDTO.Goal, palette: ShannonPalette) -> some View {
        if let summary = goal.completion?.summary, !summary.isEmpty {
            Text(ShannonGeneratedStrings.executiveGoalsCondition(summary: summary))
                .font(.shannon(.footnote))
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if goal.completion?.met == true, goal.isActive {
                Label(ShannonGeneratedStrings.executiveGoalsConditionMet, systemImage: "checkmark.seal")
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.onSuccessTint)
                    .padding(.horizontal, ShannonSpacing.small)
                    .background(palette.successTint, in: Capsule())
            }
        } else if goal.isOpen {
            Text(ShannonGeneratedStrings.executiveGoalsConditionNone)
                .font(.shannon(.footnote))
                .foregroundStyle(palette.textSecondary)
        }
    }

    /// 「3/5・次の見直し 10月16日・証拠 3件」.
    private func metaLine(_ goal: ShannonGoalsDTO.Goal, palette: ShannonPalette) -> some View {
        var parts: [String] = []
        if let progress = ShannonExecutiveText.progressLabel(goal) { parts.append(ShannonGeneratedStrings.executiveGoalsProgress(label: progress)) }
        if goal.isOpen, let review = goal.reviewAt { parts.append(ShannonGeneratedStrings.executiveGoalsReview(day: ShannonExecutiveText.day(review))) }
        if let evidence = goal.evidenceCount { parts.append(ShannonGeneratedStrings.executiveGoalsEvidence(count: String(evidence))) }
        if let interest = goal.interest, !interest.isEmpty { parts.append(ShannonGeneratedStrings.executiveGoalsInterest(interest: interest)) }
        return Text(parts.joined(separator: "・"))
            .font(.shannon(.caption))
            .monospacedDigit()
            .foregroundStyle(palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func controlButton(_ action: ShannonExecutiveModel.GoalAction, goal: ShannonGoalsDTO.Goal, color: Color) -> some View {
        Button {
            pending = Pending(goal: goal, action: action)
        } label: {
            Text(Self.actionTitle(action))
                .font(.shannon(.callout).weight(.medium))
                .foregroundStyle(color)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityHint(ShannonGeneratedStrings.executiveGoalsControlHint(title: ShannonExecutiveText.title(goal)))
    }

    // MARK: Words

    static func actionTitle(_ action: ShannonExecutiveModel.GoalAction) -> String {
        switch action {
        case .confirm: ShannonGeneratedStrings.executiveGoalsConfirm
        case .rest: ShannonGeneratedStrings.executiveGoalsRest
        case .drop: ShannonGeneratedStrings.executiveGoalsDrop
        }
    }

    static func confirmTitle(_ pending: Pending) -> String {
        let title = ShannonExecutiveText.title(pending.goal)
        switch pending.action {
        case .confirm: return ShannonGeneratedStrings.executiveGoalsConfirmTitle(title: title)
        case .rest: return ShannonGeneratedStrings.executiveGoalsRestTitle(title: title)
        case .drop: return ShannonGeneratedStrings.executiveGoalsDropTitle(title: title)
        }
    }

    static func confirmMessage(_ action: ShannonExecutiveModel.GoalAction) -> String {
        switch action {
        case .confirm: ShannonGeneratedStrings.executiveGoalsConfirmMessage
        case .rest: ShannonGeneratedStrings.executiveGoalsRestMessage
        case .drop: ShannonGeneratedStrings.executiveGoalsDropMessage
        }
    }

    // MARK: Parts

    @ViewBuilder
    private func phaseLine(_ phase: ShannonExecutiveModel.Phase, palette: ShannonPalette) -> some View {
        switch phase {
        case .notReady: quietLine(ShannonGeneratedStrings.executiveNotReady, palette: palette)
        case .unreadable: quietLine(ShannonGeneratedStrings.executiveUnreadable, palette: palette)
        case .loading, .loaded: EmptyView()
        }
    }

    private func quietLine(_ text: String, palette: ShannonPalette) -> some View {
        Text(text)
            .font(.shannon(.callout))
            .foregroundStyle(palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A small word in a capsule: an outcome, a status, a policy.
struct ShannonExecutiveChip: View {
    let text: String
    let palette: ShannonPalette

    var body: some View {
        Text(text)
            .font(.shannon(.caption))
            .foregroundStyle(palette.textSecondary)
            .lineLimit(1)
            .padding(.horizontal, ShannonSpacing.small)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(palette.divider, lineWidth: 1))
    }
}
