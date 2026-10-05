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
        Group {
            if showsDismissButton {
                NavigationStack {
                    memoryContent(palette)
                        .navigationTitle("頭の中")
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
                }
            } else {
                memoryContent(palette)
            }
        }
        .modifier(ShannonKnowledgeCorrectionModifier(
            model: model,
            editingAnswer: $editingAnswer,
            editingText: $editingText
        ))
        .sheet(item: $selectedSleepReport) { report in
            NavigationStack {
                ShannonSleepReportView(report: report)
            }
        }
    }

    @ViewBuilder
    func memoryContent(_ palette: ShannonPalette) -> some View {
#if os(iOS)
        // iPhone: いま + category list. Each category pushes a page that reuses
        // the section views below; the Mac keeps its overview composition.
        ShannonMemoryHubList(model: model, workspaceTopInset: workspaceTopInset)
#else
        ScrollView {
            LazyVStack(alignment: .leading, spacing: ShannonSpacing.large) {
                // 自律活動 is its own row of 「シャノン」 (A10), next to 頭の中, as on the iPhone (A4).
                overviewContent(palette)
            }
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.top, max(ShannonSpacing.large, workspaceTopInset))
            .padding(.bottom, ShannonSpacing.large)
        }
        .background(Color.clear)
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
#endif
    }

    @ViewBuilder
    func overviewContent(_ palette: ShannonPalette) -> some View {
        // This shared composition is also rendered directly by fixture tests;
        // LazyVStack/ScrollView virtualization must not hide the entry in tests.
        managementEntry(palette)
        peopleEntry(palette)
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

    func peopleEntry(_ palette: ShannonPalette) -> some View {
        NavigationLink {
            ShannonPeopleListPage(model: model)
        } label: {
            ShannonPeopleEntryLabel(people: model.people, palette: palette)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("memory-people-entry")
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
                ShannonPersonalityProfileCard(profile: profile, palette: palette)
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
            ShannonKnowledgeAnswerGroups(answers: answers, palette: palette) { answer in
                editingText = answer.answer
                editingAnswer = answer
            }
        }
    }

    @ViewBuilder
    func activityContent(_ palette: ShannonPalette) -> some View {
        let reports = model.dashboard?.sleepReports ?? []
        if !reports.isEmpty {
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                Label("シャノンの日記", systemImage: "book.closed.fill")
                    .font(.shannon(.title3).weight(.semibold))
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
            ShannonWorldItemSection(items: Array(world.prefix(12)), palette: palette)
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
            ShannonActivityTimelineSection(items: activity, palette: palette)
        }
    }

    func memorySection(
        _ title: String?,
        items: [ShannonMemoryItemDTO],
        palette: ShannonPalette
    ) -> some View {
        ShannonMemoryCardList(model: model, title: title, items: items, palette: palette)
    }

    func emptyState(_ title: String, symbol: String, palette: ShannonPalette) -> some View {
        ShannonMemoryEmptyState(title: title, symbol: symbol, palette: palette)
    }
}
