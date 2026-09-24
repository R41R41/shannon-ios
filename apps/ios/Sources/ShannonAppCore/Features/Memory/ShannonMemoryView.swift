import SwiftUI

public struct ShannonMemoryView: View {
    @State var model: ShannonMemoryModel
    @State var area: MemoryArea = .current
    @State var editingAnswer: ShannonKnowledgeAnswerDTO?
    @State var editingText = ""
    @State var selectedSleepReport: ShannonSleepReportDTO?
    let showsDismissButton: Bool
    let workspaceTopInset: CGFloat
    @Environment(\.dismiss) var dismiss
    @Environment(\.colorScheme) var colorScheme

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
        let palette = ShannonPalette.resolve(colorScheme)
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

    func memoryContent(_ palette: ShannonPalette) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: ShannonSpacing.large) {
                overviewContent(palette)
            }
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.top, max(ShannonSpacing.large, workspaceTopInset))
            .padding(.bottom, ShannonSpacing.large)
        }
        .background(Color.clear)
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
    }

    @ViewBuilder
    func overviewContent(_ palette: ShannonPalette) -> some View {
        // This shared composition is also rendered directly by fixture tests;
        // LazyVStack/ScrollView virtualization must not hide the entry in tests.
        managementEntry(palette)
        if let report = model.latestSleepReport {
            Button { selectedSleepReport = report } label: {
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
            case .current: currentStateContent(palette)
            case .knowledge: knowledgeContent(palette)
            case .activity: activityContent(palette)
            }
        }
        if let error = model.errorMessage {
            MemoryErrorCard(message: error, palette: palette) {
                Task { await model.reload() }
            }
        }
    }

    func managementEntry(_ palette: ShannonPalette) -> some View {
        NavigationLink {
            ShannonMemoryLibraryView(model: model)
        } label: {
            ShannonMemoryManagementLabel(
                summary: model.dashboard == nil ? "読み込み・再試行はこちらから" : ShannonMemoryLibrary(dashboard: model.dashboard).summary,
                palette: palette
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("memory-management-entry")
    }

    @ViewBuilder
    func currentStateContent(_ palette: ShannonPalette) -> some View {
        NavigationLink {
            ShannonCognitionView(model: model)
        } label: {
            ShannonCognitionManagementLabel(
                cognition: model.cognition,
                isLoading: model.isLoading,
                hasError: model.cognitionErrorMessage != nil,
                palette: palette
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("cognition-management-entry")

        if let state = model.dashboard?.currentState {
            ShannonCurrentStateCard(state: state, dailyMind: model.dashboard?.dailyMind, palette: palette)
            if let usage = model.dashboard?.usage {
                ShannonCostCard(usage: usage, palette: palette)
            }
            if let evaluation = model.dashboard?.evaluation {
                ShannonInitiativeEvaluationCard(evaluation: evaluation, palette: palette)
            }
            if let profile = model.dashboard?.personalityProfile {
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    HStack {
                        Text("性格分析").font(.title3.weight(.semibold))
                        Spacer()
                        Text("v\(profile.version)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(palette.action)
                    }
                    Text(profile.analysis)
                        .font(.body)
                        .lineSpacing(4)
                        .foregroundStyle(palette.textSecondary)
                }
                .padding(ShannonSpacing.large)
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
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
    func knowledgeContent(_ palette: ShannonPalette) -> some View {
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
                VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                    Text(group.category).font(.title3.weight(.semibold))
                    ForEach(group.answers) { answer in
                        HStack(alignment: .center, spacing: ShannonSpacing.small) {
                            KnowledgeAnswerCard(answer: answer, palette: palette)
                            Button {
                                editingText = answer.answer
                                editingAnswer = answer
                            } label: {
                                Image(systemName: "pencil")
                                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(palette.action)
                            .accessibilityLabel("\(answer.question)を編集")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    func activityContent(_ palette: ShannonPalette) -> some View {
        let reports = model.dashboard?.sleepReports ?? []
        if !reports.isEmpty {
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                Label("シャノンの日記", systemImage: "book.closed.fill")
                    .font(.title3.weight(.semibold))
                ScrollView(.horizontal) {
                    LazyHStack(spacing: ShannonSpacing.medium) {
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
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
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
                VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                    Text(group.title)
                        .font(.title3.weight(.semibold))
                    ForEach(group.items) { item in
                        ActivityTimelineRow(item: item, palette: palette)
                    }
                }
            }
        }
    }

    func memorySection(
        _ title: String?,
        items: [ShannonMemoryItemDTO],
        palette: ShannonPalette
    ) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            if let title {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .padding(.horizontal, ShannonSpacing.extraSmall)
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

    func emptyState(_ title: String, symbol: String, palette: ShannonPalette) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        }
        .foregroundStyle(palette.textSecondary)
        .padding(.vertical, ShannonSpacing.huge)
    }

    func knowledgeCategories(_ answers: [ShannonKnowledgeAnswerDTO]) -> [(category: String, answers: [ShannonKnowledgeAnswerDTO])] {
        let grouped = Dictionary(grouping: answers, by: \.category)
        let order = ["基本情報", "趣味嗜好", "興味", "その他"]
        return grouped.map { ($0.key, $0.value) }.sorted {
            (order.firstIndex(of: $0.0) ?? 99) < (order.firstIndex(of: $1.0) ?? 99)
        }
    }

    func activityGroups(_ items: [ShannonActivityItemDTO]) -> [ShannonActivityGroup] {
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
