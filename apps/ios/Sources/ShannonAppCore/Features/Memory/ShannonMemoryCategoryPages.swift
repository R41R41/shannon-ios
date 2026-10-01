import SwiftUI

/// Pages pushed from the iPhone 頭の中 category list. Each page keeps the
/// last loaded content, explains an empty category, and retries its own error.
struct ShannonMemoryCategoryPage: View {
    @Bindable var model: ShannonMemoryModel
    let category: ShannonMemoryOverview.Category

    var body: some View {
        switch category {
        case .commitments: ShannonMemoryCommitmentsPage(model: model)
        case .knowledge: ShannonMemoryKnowledgePage(model: model)
        case .relationship: ShannonMemoryRelationshipPage(model: model)
        case .diary: ShannonMemoryDiaryPage(model: model)
        case .discoveries: ShannonMemoryDiscoveriesPage(model: model)
        }
    }
}

/// Shared scroll scaffold for card-based pages. `pinned` stays visible in
/// every state (for example the memory-management entry).
struct ShannonMemoryPageScaffold<Pinned: View, Content: View>: View {
    @Bindable var model: ShannonMemoryModel
    let title: String
    let isEmpty: Bool
    let emptyTitle: String
    let emptyMessage: String
    let emptySymbol: String
    @ViewBuilder let pinned: () -> Pinned
    @ViewBuilder let content: () -> Content
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: ShannonSpacing.large) {
                pinned()
                if model.dashboard == nil {
                    if model.errorMessage == nil {
                        ProgressView("読み込み中…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, ShannonSpacing.huge)
                    }
                } else if isEmpty {
                    ShannonMemoryEmptyState(
                        title: emptyTitle,
                        symbol: emptySymbol,
                        message: emptyMessage,
                        palette: palette
                    )
                } else {
                    content()
                }
                if let error = model.errorMessage {
                    MemoryErrorCard(message: error, palette: palette) {
                        Task { await model.reload() }
                    }
                }
            }
            .padding(ShannonSpacing.large)
        }
        .background(palette.canvas)
        .navigationTitle(title)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
    }
}

extension ShannonMemoryPageScaffold where Pinned == EmptyView {
    init(
        model: ShannonMemoryModel,
        category: ShannonMemoryOverview.Category,
        isEmpty: Bool,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            model: model,
            title: category.title,
            isEmpty: isEmpty,
            emptyTitle: category.emptyTitle,
            emptyMessage: category.emptyMessage,
            emptySymbol: category.symbol,
            pinned: { EmptyView() },
            content: content
        )
    }
}

struct ShannonMemoryKnowledgePage: View {
    @Bindable var model: ShannonMemoryModel
    @State private var editingAnswer: ShannonKnowledgeAnswerDTO?
    @State private var editingText = ""
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let overview = ShannonMemoryOverview(model: model)
        let category = ShannonMemoryOverview.Category.knowledge
        ShannonMemoryPageScaffold(
            model: model,
            title: category.title,
            isEmpty: overview.isEmpty(category),
            emptyTitle: category.emptyTitle,
            emptyMessage: category.emptyMessage,
            emptySymbol: category.symbol
        ) {
            NavigationLink {
                ShannonMemoryLibraryView(model: model)
            } label: {
                ShannonMemoryManagementLabel(summary: overview.managementSummary, palette: palette)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("memory-knowledge-management-entry")
        } content: {
            if let profile = model.dashboard?.personalityProfile {
                ShannonPersonalityProfileCard(profile: profile, palette: palette)
            }
            if !overview.interests.isEmpty {
                MemorySimpleSection(title: "興味", symbol: "sparkles", values: overview.interests, palette: palette)
            }
            if !overview.knowledgeAnswers.isEmpty {
                ShannonKnowledgeAnswerGroups(answers: overview.knowledgeAnswers, palette: palette) { answer in
                    editingText = answer.answer
                    editingAnswer = answer
                }
            } else if !overview.userFacts.isEmpty {
                ShannonMemoryCardList(model: model, title: "あなたについて", items: overview.userFacts, palette: palette)
            }
        }
        .modifier(ShannonKnowledgeCorrectionModifier(
            model: model,
            editingAnswer: $editingAnswer,
            editingText: $editingText
        ))
    }
}

struct ShannonMemoryRelationshipPage: View {
    @Bindable var model: ShannonMemoryModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let overview = ShannonMemoryOverview(model: model)
        ShannonMemoryPageScaffold(
            model: model,
            category: .relationship,
            isEmpty: overview.isEmpty(.relationship)
        ) {
            ShannonMemoryCardList(model: model, title: nil, items: overview.relationships, palette: palette)
        }
    }
}

struct ShannonMemoryDiaryPage: View {
    @Bindable var model: ShannonMemoryModel
    @State private var selectedReport: ShannonSleepReportDTO?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let overview = ShannonMemoryOverview(model: model)
        ShannonMemoryPageScaffold(model: model, category: .diary, isEmpty: overview.isEmpty(.diary)) {
            ForEach(model.dashboard?.sleepReports ?? []) { report in
                Button {
                    selectedReport = report
                } label: {
                    ShannonDiaryRow(report: report, palette: palette)
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(item: $selectedReport) { report in
            NavigationStack {
                ShannonSleepReportView(report: report)
            }
        }
    }
}

struct ShannonMemoryDiscoveriesPage: View {
    @Bindable var model: ShannonMemoryModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let overview = ShannonMemoryOverview(model: model)
        ShannonMemoryPageScaffold(model: model, category: .discoveries, isEmpty: overview.isEmpty(.discoveries)) {
            ShannonWorldItemSection(items: model.dashboard?.world ?? [], palette: palette, title: nil)
        }
    }
}

struct ShannonMemoryActivityPage: View {
    @Bindable var model: ShannonMemoryModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let overview = ShannonMemoryOverview(model: model)
        let dashboard = model.dashboard
        let isEmpty = dashboard?.usage == nil && dashboard?.evaluation == nil
            && overview.activityItems.isEmpty && overview.experiences.isEmpty
        ShannonMemoryPageScaffold(
            model: model,
            title: "使用量と活動",
            isEmpty: isEmpty,
            emptyTitle: "活動履歴はまだありません",
            emptyMessage: "会話や睡眠中の整理、話しかけた記録がここに残ります。",
            emptySymbol: "clock.arrow.circlepath",
            pinned: { EmptyView() }
        ) {
            if let usage = dashboard?.usage {
                ShannonCostCard(usage: usage, palette: palette)
            }
            if let evaluation = dashboard?.evaluation {
                ShannonInitiativeEvaluationCard(evaluation: evaluation, palette: palette)
            }
            if !overview.activityItems.isEmpty {
                ShannonActivityTimelineSection(items: overview.activityItems, palette: palette)
            } else if !overview.experiences.isEmpty {
                ShannonMemoryCardList(model: model, title: "思い出", items: overview.experiences, palette: palette)
            } else {
                ShannonMemoryEmptyState(
                    title: "活動履歴はまだありません",
                    symbol: "clock.arrow.circlepath",
                    palette: palette
                )
            }
        }
    }
}

struct ShannonMemoryCurrentStatePage: View {
    @Bindable var model: ShannonMemoryModel
    @State private var selectedReport: ShannonSleepReportDTO?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ShannonMemoryPageScaffold(
            model: model,
            title: "いまのシャノン",
            isEmpty: model.dashboard?.currentState == nil && model.latestSleepReport == nil,
            emptyTitle: "いまの状態はまだありません",
            emptyMessage: "会話を重ねると、シャノンの気分や今日の関心がここに表示されます。",
            emptySymbol: "waveform.path.ecg",
            pinned: { EmptyView() }
        ) {
            if let state = model.dashboard?.currentState {
                ShannonCurrentStateCard(state: state, dailyMind: model.dashboard?.dailyMind, palette: palette)
            }
            if let report = model.latestSleepReport {
                Button { selectedReport = report } label: {
                    SleepSummaryCard(report: report, palette: palette)
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(item: $selectedReport) { report in
            NavigationStack {
                ShannonSleepReportView(report: report)
            }
        }
    }
}

struct ShannonDiaryRow: View {
    let report: ShannonSleepReportDTO
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: "moon.stars.fill")
                .foregroundStyle(palette.action)
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text(report.dayKey)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
                Text(report.diaryTitle)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(report.diarySummary)
                    .font(.callout)
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.textSecondary)
                .accessibilityHidden(true)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.65), lineWidth: 0.7)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("その夜の日記を開きます")
    }
}
