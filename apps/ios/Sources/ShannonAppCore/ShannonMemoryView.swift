import SwiftUI

public struct ShannonMemoryView: View {
    @State private var model: ShannonMemoryModel
    @State private var area: MemoryArea = .current
    @State private var editingAnswer: ShannonKnowledgeAnswerDTO?
    @State private var editingText = ""
    @State private var selectedSleepReport: ShannonSleepReportDTO?
    private let showsDismissButton: Bool
    private let workspaceTopInset: CGFloat
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    public init(
        model: ShannonMemoryModel = ShannonMemoryModel(),
        showsDismissButton: Bool = true,
        workspaceTopInset: CGFloat = 0
    ) {
        _model = State(initialValue: model)
        self.showsDismissButton = showsDismissButton
        self.workspaceTopInset = workspaceTopInset
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        NavigationStack {
            if showsDismissButton {
                memoryContent(palette)
                    .navigationTitle("シャノンの記憶")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("閉じる") { dismiss() }
                        }
                        ToolbarItem(placement: .primaryAction) {
                            Button { Task { await model.reload() } } label: {
                                Image(systemName: "arrow.clockwise")
                            }
                            .disabled(model.isLoading)
                            .accessibilityLabel("記憶を更新")
                        }
                    }
            } else {
                memoryContent(palette)
            }
        }
        .sheet(item: $editingAnswer) { answer in
            NavigationStack {
                Form {
                    Section(answer.question) {
                        TextField("回答", text: $editingText, axis: .vertical)
                            .lineLimit(2...8)
                    }
                }
                .navigationTitle("知識を訂正")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("キャンセル") { editingAnswer = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") {
                            let value = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task {
                                if await model.correctKnowledge(answerID: answer.answerId, answer: value) {
                                    editingAnswer = nil
                                }
                            }
                        }
                        .disabled(editingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(item: $selectedSleepReport) { report in
            NavigationStack {
                ShannonSleepReportView(report: report)
            }
        }
    }

    private func memoryContent(_ palette: M3Palette) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: M3Spacing.large) {
                if let report = model.latestSleepReport {
                    Button {
                        selectedSleepReport = report
                    } label: {
                        SleepSummaryCard(report: report, palette: palette)
                    }
                    .buttonStyle(.plain)
                }
                Picker("表示", selection: $area) {
                    ForEach(MemoryArea.allCases) { area in
                        Label(area.title, systemImage: area.symbol).tag(area)
                    }
                }
                .pickerStyle(.segmented)

                if model.isLoading && model.dashboard == nil {
                    ProgressView("読み込み中…")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 64)
                } else {
                    switch area {
                    case .current:
                        currentStateContent(palette)
                    case .knowledge:
                        knowledgeContent(palette)
                    case .activity:
                        activityContent(palette)
                    }
                }

                if let error = model.errorMessage {
                    MemoryErrorCard(message: error, palette: palette) {
                        Task { await model.reload() }
                    }
                }
            }
            .padding(.horizontal, M3Spacing.large)
            .padding(.top, max(M3Spacing.large, workspaceTopInset))
            .padding(.bottom, M3Spacing.large)
        }
        .background(Color.clear)
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
    }

    @ViewBuilder
    private func currentStateContent(_ palette: M3Palette) -> some View {
        if let state = model.dashboard?.currentState {
            ShannonCurrentStateCard(state: state, dailyMind: model.dashboard?.dailyMind, palette: palette)
            if let usage = model.dashboard?.usage {
                ShannonCostCard(usage: usage, palette: palette)
            }
            if let evaluation = model.dashboard?.evaluation {
                ShannonInitiativeEvaluationCard(evaluation: evaluation, palette: palette)
            }
            if let profile = model.dashboard?.personalityProfile {
                VStack(alignment: .leading, spacing: M3Spacing.small) {
                    HStack {
                        Text("性格分析").font(.title3.weight(.semibold))
                        Spacer()
                        Text("v\(profile.version)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(palette.primary)
                    }
                    Text(profile.analysis)
                        .font(.body)
                        .lineSpacing(4)
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                .padding(M3Spacing.large)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
            }
            if !state.interests.isEmpty {
                MemorySimpleSection(title: "興味", symbol: "sparkles", values: state.interests, palette: palette)
            }
        } else {
            let interests = model.activeItems.filter { $0.kind == .interest }
            let relationships = model.activeItems.filter { $0.kind == .relationship }
            if interests.isEmpty && relationships.isEmpty {
                emptyState("いまの状態はまだありません", symbol: "waveform.path.ecg", palette: palette)
            } else {
                if !interests.isEmpty { memorySection(nil, items: interests, palette: palette) }
                if !relationships.isEmpty { memorySection("ふたりの関係", items: relationships, palette: palette) }
            }
        }
    }

    @ViewBuilder
    private func knowledgeContent(_ palette: M3Palette) -> some View {
        let answers = model.dashboard?.knowledge ?? []
        if answers.isEmpty {
            let facts = model.activeItems.filter { $0.kind == .userFact }
            if facts.isEmpty {
                emptyState("知識はまだありません", symbol: "books.vertical", palette: palette)
            } else {
                memorySection(nil, items: facts, palette: palette)
            }
        } else {
            ForEach(knowledgeCategories(answers), id: \.category) { group in
                VStack(alignment: .leading, spacing: M3Spacing.medium) {
                    Text(group.category).font(.title3.weight(.semibold))
                    ForEach(group.answers) { answer in
                        HStack(alignment: .center, spacing: M3Spacing.small) {
                            KnowledgeAnswerCard(answer: answer, palette: palette)
                            Button {
                                editingText = answer.answer
                                editingAnswer = answer
                            } label: {
                                Image(systemName: "pencil")
                                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(palette.primary)
                            .accessibilityLabel("\(answer.question)を編集")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func activityContent(_ palette: M3Palette) -> some View {
        let reports = model.dashboard?.sleepReports ?? []
        if !reports.isEmpty {
            VStack(alignment: .leading, spacing: M3Spacing.medium) {
                Label("シャノンの日記", systemImage: "book.closed.fill")
                    .font(.title3.weight(.semibold))
                ScrollView(.horizontal) {
                    LazyHStack(spacing: M3Spacing.medium) {
                        ForEach(reports.prefix(14)) { report in
                            Button {
                                selectedSleepReport = report
                            } label: {
                                ShannonDiaryCard(report: report, palette: palette)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }

        let world = model.dashboard?.world ?? []
        if !world.isEmpty {
            VStack(alignment: .leading, spacing: M3Spacing.medium) {
                Text("見つけたもの").font(.title3.weight(.semibold))
                ForEach(world.prefix(12)) { item in
                    if let url = URL(string: item.url) {
                        Link(destination: url) {
                            WorldItemCard(item: item, palette: palette)
                        }
                        .buttonStyle(.plain)
                    } else {
                        WorldItemCard(item: item, palette: palette)
                    }
                }
            }
        }
        let activity = model.dashboard?.activity ?? []
        if activity.isEmpty {
            let experiences = model.activeItems.filter { $0.kind == .experience }
            if experiences.isEmpty {
                emptyState("活動履歴はまだありません", symbol: "clock.arrow.circlepath", palette: palette)
            } else {
                memorySection(nil, items: experiences, palette: palette)
            }
        } else {
            ForEach(activityGroups(activity)) { group in
                VStack(alignment: .leading, spacing: M3Spacing.medium) {
                    Text(group.title)
                        .font(.title3.weight(.semibold))
                    ForEach(group.items) { item in
                        ActivityTimelineRow(item: item, palette: palette)
                    }
                }
            }
        }
    }

    private func memorySection(
        _ title: String?,
        items: [ShannonMemoryItemDTO],
        palette: M3Palette
    ) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            if let title {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .padding(.horizontal, M3Spacing.extraSmall)
            }
            ForEach(items) { item in
                NavigationLink {
                    ShannonMemoryDetailView(model: model, memoryID: item.id)
                } label: {
                    MemoryCard(item: item, palette: palette)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func emptyState(_ title: String, symbol: String, palette: M3Palette) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        }
        .foregroundStyle(palette.onSurfaceVariant)
        .padding(.vertical, M3Spacing.huge)
    }

    private func knowledgeCategories(_ answers: [ShannonKnowledgeAnswerDTO]) -> [(category: String, answers: [ShannonKnowledgeAnswerDTO])] {
        let grouped = Dictionary(grouping: answers, by: \.category)
        let order = ["基本情報", "趣味嗜好", "興味", "その他"]
        return grouped.map { ($0.key, $0.value) }.sorted {
            (order.firstIndex(of: $0.0) ?? 99) < (order.firstIndex(of: $1.0) ?? 99)
        }
    }

    private func activityGroups(_ items: [ShannonActivityItemDTO]) -> [ShannonActivityGroup] {
        let calendar = Calendar.current
        let now = Date()
        let thisWeek = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        var today: [ShannonActivityItemDTO] = []
        var week: [ShannonActivityItemDTO] = []
        var earlier: [ShannonActivityItemDTO] = []

        for item in items {
            guard let date = parsedDate(item.occurredAt) else {
                earlier.append(item)
                continue
            }
            if calendar.isDateInToday(date) {
                today.append(item)
            } else if date >= thisWeek {
                week.append(item)
            } else {
                earlier.append(item)
            }
        }

        return [
            ShannonActivityGroup(id: "today", title: "今日", items: today),
            ShannonActivityGroup(id: "week", title: "今週", items: week),
            ShannonActivityGroup(id: "earlier", title: "それ以前", items: earlier),
        ].filter { !$0.items.isEmpty }
    }
}

private struct ShannonActivityGroup: Identifiable {
    let id: String
    let title: String
    let items: [ShannonActivityItemDTO]
}

private struct ShannonCostCard: View {
    let usage: ShannonLlmUsageSummaryDTO
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            HStack {
                Label("今月のAI使用量", systemImage: "gauge.with.dots.needle.50percent")
                    .font(.title3.weight(.semibold))
                Spacer()
                Text(usage.monthKey).font(.caption.monospacedDigit()).foregroundStyle(palette.onSurfaceVariant)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(usage.estimatedCostUsd, format: .currency(code: "USD"))
                    .font(.title2.bold()).foregroundStyle(palette.primary)
                Spacer()
                Text("バックグラウンド残り \(usage.backgroundRemainingUsd, format: .currency(code: "USD"))")
                    .font(.caption).foregroundStyle(palette.onSurfaceVariant)
            }
            if let today = usage.todayBackgroundCostUsd {
                HStack {
                    Text("今日のバックグラウンド")
                    Spacer()
                    Text(today, format: .currency(code: "USD"))
                        .monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
            }
            ProgressView(
                value: usage.backgroundBudgetUsd > 0
                    ? min(1, usage.backgroundCostUsd / usage.backgroundBudgetUsd)
                    : 1
            )
            .tint(usage.backgroundRemainingUsd > 0 ? palette.primary : palette.error)
            HStack {
                Text("会話 \(calls(for: "chat"))回")
                Spacer()
                Text("音声 \(calls(for: "voice"))回")
                Spacer()
                Text("バックグラウンド \(calls(for: "sleep"))回")
            }
            .font(.caption)
            .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.extraLarge)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
    }

    private func calls(for lane: String) -> Int {
        usage.rows.first(where: { $0.lane == lane })?.calls ?? 0
    }
}

private struct ShannonInitiativeEvaluationCard: View {
    let evaluation: ShannonInitiativeEvaluationDTO
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            HStack {
                Label("最近の自発性", systemImage: "bubble.left.and.sparkles")
                    .font(.title3.weight(.semibold))
                Spacer()
                Text("\(evaluation.windowDays)日")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(evaluation.deliveryRate, format: .percent.precision(.fractionLength(0)))
                    .font(.title2.bold())
                    .foregroundStyle(palette.primary)
                Text("話しかけた割合")
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
                Spacer()
                Text("\(evaluation.delivered)件")
                    .font(.body.weight(.semibold))
            }
            ProgressView(value: min(1, evaluation.deliveryRate))
                .tint(palette.primary)
            HStack {
                Text("候補 \(evaluation.candidatesConsidered)件")
                Spacer()
                Text("静かにした \(silentRuns)回")
            }
            .font(.caption)
            .foregroundStyle(palette.onSurfaceVariant)
            if let suppressed = evaluation.repeatedCandidatesSuppressed, suppressed > 0 {
                Label("重複候補を\(suppressed)件、静かに除外", systemImage: "line.3.horizontal.decrease.circle")
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            if !sourceSummary.isEmpty {
                Text("配信元: \(sourceSummary)")
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
                    .lineLimit(2)
            }
        }
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.extraLarge)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
    }

    private var silentRuns: Int {
        evaluation.stopped.values.reduce(0, +)
    }

    private var sourceSummary: String {
        (evaluation.deliveredBySource ?? []).prefix(3)
            .map { "\($0.sourceTitle) \($0.count)件" }
            .joined(separator: "・")
    }
}

private struct WorldItemCard: View {
    let item: ShannonWorldItemDTO
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: "globe.asia.australia.fill")
                .foregroundStyle(palette.primary)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(palette.onSurface)
                    .lineLimit(3)
                Text(item.sourceTitle)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.medium)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.medium))
    }
}

private enum MemoryArea: String, CaseIterable, Identifiable {
    case current, knowledge, activity
    var id: String { rawValue }
    var title: String {
        switch self {
        case .current: "いま"
        case .knowledge: "知識"
        case .activity: "記憶"
        }
    }
    var symbol: String {
        switch self {
        case .current: "waveform.path.ecg"
        case .knowledge: "books.vertical"
        case .activity: "clock.arrow.circlepath"
        }
    }
}

private struct ShannonCurrentStateCard: View {
    let state: CompanionStateDTO
    let dailyMind: ShannonDailyMindDTO?
    let palette: M3Palette
    @State private var showsDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.large) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Label("いまのシャノン", systemImage: "brain.head.profile.fill")
                        .font(.title3.weight(.semibold))
                    Text("更新 \(displayDate(state.updatedAt))")
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                Spacer()
                Text("v\(state.version)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.primary)
            }
            HStack(spacing: M3Spacing.medium) {
                Image(systemName: dominantState.symbol)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(palette.onPrimaryContainer)
                    .frame(width: 52, height: 52)
                    .background(palette.primaryContainer, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(dominantState.label)
                        .font(.title2.weight(.semibold))
                    Text(dominantState.value.formatted(.percent.precision(.fractionLength(0))))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.onSurfaceVariant)
                }
            }

            if let focus = dailyMind {
                VStack(alignment: .leading, spacing: 5) {
                    Text("今日の関心")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.primary)
                    Text(focus.topic)
                        .font(.title3.weight(.medium))
                        .foregroundStyle(palette.onSurface)
                    Text(focus.reason)
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                    if let title = focus.sourceTitle, let url = focus.sourceURL, let sourceURL = URL(string: url) {
                        Link(destination: sourceURL) {
                            Label(title, systemImage: "arrow.up.right")
                                .font(.caption.weight(.medium))
                                .lineLimit(1)
                        }
                    }
                }
                .padding(M3Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.primaryContainer.opacity(0.56), in: RoundedRectangle(cornerRadius: M3Shape.large))
            }

            if !state.activeMemories.isEmpty {
                VStack(alignment: .leading, spacing: M3Spacing.small) {
                    Text("頭に浮かんでいること")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.onSurfaceVariant)
                    ForEach(state.activeMemories.prefix(2)) { memory in
                        HStack(alignment: .top, spacing: M3Spacing.small) {
                            Circle().fill(palette.primary).frame(width: 6, height: 6).padding(.top, 6)
                            Text(memory.summary)
                                .font(.callout)
                                .foregroundStyle(palette.onSurface)
                                .lineLimit(2)
                        }
                    }
                }
            }

            DisclosureGroup(isExpanded: $showsDetails) {
                VStack(spacing: M3Spacing.medium) {
                    stateMeter("気分", value: (state.emotion.valence + 1) / 2)
                    stateMeter("活性", value: state.emotion.arousal)
                    stateMeter("心の開き", value: state.emotion.openness)
                    stateMeter("好奇心", value: state.temperament.curiosity)
                    stateMeter("親密さ", value: state.temperament.closeness)
                }
                .padding(.top, M3Spacing.medium)
            } label: {
                Text("状態の詳細")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            .tint(palette.primary)
        }
        .padding(M3Spacing.large)
        .background(
            LinearGradient(
                colors: [palette.surface, palette.primaryContainer.opacity(0.18)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: M3Shape.extraLarge)
        )
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.extraLarge)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
    }

    private func stateMeter(_ title: String, value: Double) -> some View {
        VStack(spacing: 5) {
            HStack {
                Text(title).font(.callout)
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            ProgressView(value: min(1, max(0, value))).tint(palette.primary)
        }
    }

    private var dominantState: (label: String, symbol: String, value: Double) {
        let candidates = [
            ("好奇心が強い", "sparkles", state.temperament.curiosity),
            ("心を開いている", "heart.circle.fill", state.emotion.openness),
            ("元気がある", "bolt.fill", state.emotion.arousal),
            ("穏やか", "cloud.sun.fill", state.temperament.calmness),
            ("距離が近い", "person.2.fill", state.temperament.closeness),
        ]
        return candidates.max(by: { $0.2 < $1.2 }) ?? candidates[0]
    }
}

private struct MemorySimpleSection: View {
    let title: String
    let symbol: String
    let values: [String]
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(title, systemImage: symbol).font(.title3.weight(.semibold))
            ForEach(values, id: \.self) { value in
                Text(value)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(M3Spacing.medium)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.medium))
            }
        }
    }
}

private struct KnowledgeAnswerCard: View {
    let answer: ShannonKnowledgeAnswerDTO
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(answer.question)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.primary)
                Spacer()
                if answer.confirmed {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.caption)
                        .foregroundStyle(palette.primary)
                }
            }
            Text(answer.answer)
                .font(.body)
                .foregroundStyle(palette.onSurface)
                .multilineTextAlignment(.leading)
            HStack {
                Text(answer.source == "user" ? "手動編集" : answer.source == "conversation" ? "会話" : "AI推測")
                Spacer()
                Text(answer.confidence.formatted(.percent.precision(.fractionLength(0))))
            }
            .font(.caption)
            .foregroundStyle(palette.onSurfaceVariant)
            Text("更新 \(displayDate(answer.updatedAt))")
                .font(.caption2)
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
    }
}

private struct ShannonDiaryCard: View {
    let report: ShannonSleepReportDTO
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            HStack {
                Image(systemName: "moon.stars.fill")
                    .foregroundStyle(palette.primary)
                Spacer()
                Text(report.dayKey)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.onSurface)
                .lineLimit(2)
            Text(summary)
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
                .lineLimit(3)
            Spacer(minLength: 0)
            HStack {
                Text("読む")
                Spacer()
                Image(systemName: "chevron.right")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.primary)
        }
        .padding(M3Spacing.large)
        .frame(width: 236, height: 176, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
    }

    private var title: String {
        if let interest = report.interestChanges.first { return interest.text }
        if let learned = report.learned.first { return learned.text }
        if let updated = report.updated.first { return updated.text }
        if !report.contradictions.isEmpty { return "まだ決めずに置いておくこと" }
        return "静かに整理した夜"
    }

    private var summary: String {
        if let interest = report.interestChanges.first {
            return "「\(interest.text)」が、今日は少し心に残った。"
        }
        if let learned = report.learned.first {
            return "あなたについて「\(learned.text)」を新しく覚えた。"
        }
        if let updated = report.updated.first {
            return "「\(updated.text)」について、前より少し理解が深まった。"
        }
        if !report.contradictions.isEmpty {
            return "まだ決めつけずに置いておきたいことがあった。"
        }
        return "今日は大きく書き換えず、静かに覚えている。"
    }
}

private struct ActivityTimelineRow: View {
    let item: ShannonActivityItemDTO
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: symbol)
                .foregroundStyle(palette.primary)
                .frame(width: 36, height: 36)
                .background(palette.secondaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title).font(.body.weight(.semibold))
                if let detail = item.detail, !detail.isEmpty {
                    Text(detail).font(.callout).foregroundStyle(palette.onSurfaceVariant).lineLimit(3)
                }
                Text(displayDate(item.occurredAt)).font(.caption).foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()
        }
        .padding(.vertical, M3Spacing.extraSmall)
    }

    private var symbol: String {
        switch item.type {
        case "sleep": "moon.stars.fill"
        case "knowledge": "brain.head.profile"
        case "conversation": "bubble.left.and.bubble.right"
        default: "sparkles"
        }
    }
}

private struct MemoryCard: View {
    let item: ShannonMemoryItemDTO
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: item.kind.symbolName)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.primary)
                .frame(width: 44, height: 44)
                .background(palette.secondaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(item.kind.japaneseName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.primary)
                    if item.pinned { Image(systemName: "pin.fill").foregroundStyle(palette.tertiary) }
                    if item.status != .active {
                        Text(item.status == .rejected ? "事実ではない" : "忘れる")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(palette.errorContainer, in: Capsule())
                    }
                }
                Text(item.text)
                    .font(.body)
                    .foregroundStyle(item.status == .active ? palette.onSurface : palette.onSurfaceVariant)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                HStack {
                    Text(item.changeReason)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
            }
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.7), lineWidth: 0.7)
        }
    }
}

private struct SleepSummaryCard: View {
    let report: ShannonSleepReportDTO
    let palette: M3Palette

    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: "moon.stars.fill")
                .font(.system(size: 25))
                .foregroundStyle(palette.onPrimaryContainer)
                .frame(width: 52, height: 52)
                .background(palette.primaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text("眠っている間に考えたこと")
                    .font(.headline)
                Text(sleepSummary(report))
                    .font(.subheadline)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }
}

private struct ShannonMemoryDetailView: View {
    @Bindable var model: ShannonMemoryModel
    let memoryID: String
    @State private var showsCorrection = false
    @State private var correction = ""
    @State private var destructiveAction: ShannonMemoryActionDTO?
    @Environment(\.colorScheme) private var colorScheme

    private var item: ShannonMemoryItemDTO? { model.dashboard?.items.first { $0.id == memoryID } }

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        ScrollView {
            if let item {
                VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                    detailHeader(item, palette)
                    if let confidence = item.confidence { confidenceCard(confidence, palette) }
                    evidenceSection(item, palette)
                    historySection(item, palette)
                    actions(item, palette)
                    if let error = model.errorMessage {
                        MemoryErrorCard(message: error, palette: palette) { model.dismissError() }
                    }
                }
                .padding(M3Spacing.large)
            } else {
                ContentUnavailableView("記憶が見つかりません", systemImage: "questionmark.folder")
                    .padding(.top, 80)
            }
        }
        .background(palette.surfaceContainerLow)
        .navigationTitle("記憶の詳細")
        .sheet(isPresented: $showsCorrection) {
            correctionSheet(palette)
        }
        .confirmationDialog("この記憶をどう扱いますか？", isPresented: Binding(
            get: { destructiveAction != nil }, set: { if !$0 { destructiveAction = nil } }
        ), titleVisibility: .visible) {
            if destructiveAction == .forget {
                Button("忘れる", role: .destructive) { perform(.forget) }
            } else if destructiveAction == .reject {
                Button("事実ではないと記録", role: .destructive) { perform(.reject) }
            }
            Button("キャンセル", role: .cancel) { destructiveAction = nil }
        } message: {
            Text(destructiveAction == .reject
                 ? "今後の睡眠バッチでも同じ内容を自動で覚え直しません。"
                 : "会話の生成には使われなくなります。あとから復元できます。")
        }
    }

    private func detailHeader(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(item.kind.japaneseName, systemImage: item.kind.symbolName)
                .font(.callout.weight(.semibold))
                .foregroundStyle(palette.primary)
            Text(item.text)
                .font(.title2.weight(.semibold))
                .textSelection(.enabled)
            if item.status != .active {
                Label(item.status == .rejected ? "事実ではないと指定済み" : "忘れるよう指定済み",
                      systemImage: item.status == .rejected ? "xmark.seal.fill" : "eye.slash.fill")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.error)
            }
        }
        .padding(M3Spacing.extraLarge)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
    }

    private func confidenceCard(_ value: Double, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.small) {
            HStack {
                Text("確信度").font(.headline)
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.headline.monospacedDigit())
            }
            ProgressView(value: value).tint(palette.primary)
            Text("同じ内容が会話で再確認されると上がります。矛盾した時は自動で上書きしません。")
                .font(.caption).foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }

    private func evidenceSection(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Text("そう思った根拠").font(.title3.weight(.semibold))
            if item.evidence.isEmpty {
                Text("直接の引用は残っていません。")
                    .foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(Array(item.evidence.enumerated()), id: \.offset) { _, evidence in
                    VStack(alignment: .leading, spacing: 7) {
                        Text("“\(evidence.quote)”")
                            .font(.body).italic().textSelection(.enabled)
                        Text("\(sourceName(evidence.source))・\(displayDate(evidence.observedAt))")
                            .font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.secondaryContainer.opacity(0.7), in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }

    private func historySection(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Text("この記憶の履歴").font(.title3.weight(.semibold))
            LabeledContent("覚えた日", value: displayDate(item.createdAt))
            LabeledContent("最後の変化", value: displayDate(item.updatedAt))
            LabeledContent("変わった理由", value: item.changeReason)
        }
        .font(.body)
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }

    private func actions(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(spacing: M3Spacing.small) {
            if item.status == .active {
                actionButton(item.pinned ? "固定を外す" : "大切な記憶として固定",
                             symbol: item.pinned ? "pin.slash" : "pin.fill", palette: palette) {
                    perform(item.pinned ? .unpin : .pin)
                }
                actionButton("内容を訂正", symbol: "pencil", palette: palette) {
                    correction = item.text
                    showsCorrection = true
                }
                actionButton("この記憶を忘れる", symbol: "eye.slash", palette: palette, destructive: true) {
                    destructiveAction = .forget
                }
                actionButton("これは事実ではない", symbol: "xmark.seal", palette: palette, destructive: true) {
                    destructiveAction = .reject
                }
            } else {
                actionButton("この記憶を復元", symbol: "arrow.uturn.backward", palette: palette) {
                    perform(.restore)
                }
            }
        }
        .disabled(model.mutatingMemoryID != nil)
    }

    private func actionButton(
        _ title: String, symbol: String, palette: M3Palette, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: symbol).frame(width: 28)
                Text(title).font(.body.weight(.medium))
                Spacer()
                if model.mutatingMemoryID == memoryID { ProgressView().controlSize(.small) }
            }
            .foregroundStyle(destructive ? palette.error : palette.primary)
            .padding(.horizontal, M3Spacing.large)
            .frame(minHeight: 56)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        }
        .buttonStyle(.plain)
    }

    private func correctionSheet(_ palette: M3Palette) -> some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: M3Spacing.large) {
                Text("シャノンが覚える正しい内容を書いてください。元の根拠と訂正履歴は残ります。")
                    .font(.body).foregroundStyle(palette.onSurfaceVariant)
                TextEditor(text: $correction)
                    .padding(M3Spacing.medium)
                    .frame(minHeight: 150)
                    .background(palette.surfaceContainerHigh, in: RoundedRectangle(cornerRadius: M3Shape.large))
                Spacer()
            }
            .padding(M3Spacing.large)
            .background(palette.surface)
            .navigationTitle("記憶を訂正")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { showsCorrection = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        guard let item else { return }
                        Task {
                            if await model.act(on: item, action: .correct, text: correction) { showsCorrection = false }
                        }
                    }
                    .disabled(correction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func perform(_ action: ShannonMemoryActionDTO) {
        destructiveAction = nil
        guard let item else { return }
        Task { _ = await model.act(on: item, action: action) }
    }
}

private struct ShannonSleepReportView: View {
    let report: ShannonSleepReportDTO
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("\(report.dayKey) の睡眠", systemImage: "moon.stars.fill")
                        .font(.title2.weight(.semibold))
                    Text("会話を振り返り、急いで結論にせず整理した結果です。")
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                .padding(M3Spacing.extraLarge)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.primaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                reportSection("新しく覚えたこと", symbol: "plus.circle.fill", changes: report.learned, palette: palette)
                reportSection("理解が深まったこと", symbol: "arrow.triangle.2.circlepath", changes: report.updated, palette: palette)
                reportSection("興味の変化", symbol: "sparkles", changes: report.interestChanges, palette: palette)
                contradictionSection(palette)
            }
            .padding(M3Spacing.large)
        }
        .background(palette.surfaceContainerLow)
        .navigationTitle("睡眠後の変化")
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("閉じる") { dismiss() }
            }
        }
    }

    private func reportSection(
        _ title: String, symbol: String, changes: [ShannonSleepChangeDTO], palette: M3Palette
    ) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(title, systemImage: symbol).font(.title3.weight(.semibold))
            if changes.isEmpty {
                Text("今回はありません").foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(changes) { change in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(change.text).font(.body.weight(.medium))
                        Text(change.reason).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }

    private func contradictionSection(_ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label("矛盾として保留したこと", systemImage: "arrow.left.arrow.right.circle.fill")
                .font(.title3.weight(.semibold))
            if report.contradictions.isEmpty {
                Text("今回はありません").foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(report.contradictions) { conflict in
                    VStack(alignment: .leading, spacing: M3Spacing.small) {
                        Text("いまの理解").font(.caption.weight(.semibold)).foregroundStyle(palette.primary)
                        Text(conflict.currentText)
                        Divider()
                        Text("新しく見つけた表現").font(.caption.weight(.semibold)).foregroundStyle(palette.tertiary)
                        Text(conflict.candidateText)
                        Text(conflict.reason).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .background(palette.tertiaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }
}

private struct MemoryErrorCard: View {
    let message: String
    let palette: M3Palette
    let action: () -> Void
    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(palette.error)
            Text(message).font(.callout)
            Spacer()
            Button("再試行", action: action).font(.callout.weight(.semibold)).foregroundStyle(palette.primary)
        }
        .padding(M3Spacing.large)
        .background(palette.errorContainer, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }
}

private func sleepSummary(_ report: ShannonSleepReportDTO) -> String {
    if let interest = report.interestChanges.first { return "「\(interest.text)」が少し心に残った" }
    if let learned = report.learned.first { return "「\(learned.text)」を新しく覚えた" }
    if let updated = report.updated.first { return "「\(updated.text)」への理解が少し深まった" }
    if !report.contradictions.isEmpty { return "まだ決めつけずに置いたことがある" }
    return "昨夜は静かに記憶を整理した"
}

private func displayDate(_ value: String) -> String {
    let date = parsedDate(value)
    return date?.formatted(date: .abbreviated, time: .shortened) ?? value
}

private func parsedDate(_ value: String) -> Date? {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    return (try? fractional.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
}

private func sourceName(_ value: String) -> String {
    switch value {
    case "conversation": "会話"
    case "sleep": "睡眠中の整理"
    case "user": "あなたの訂正"
    default: value
    }
}
