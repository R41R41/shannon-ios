import SwiftUI

enum ShannonAgentTaskOverviewFilter: String, CaseIterable, Identifiable {
    case all
    case attention
    case active
    case proposed
    case finished

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "すべて"
        case .attention: "要確認"
        case .active: "進行中"
        case .proposed: "未開始"
        case .finished: "完了"
        }
    }
}

struct ShannonAgentTaskOverviewProjection {
    let pinned: [ShannonAgentTask]
    let active: [ShannonAgentTask]
    let proposed: [ShannonAgentTask]
    let finished: [ShannonAgentTask]
    let archived: [ShannonAgentTask]

    init(
        tasks: [ShannonAgentTask],
        query: String = "",
        filter: ShannonAgentTaskOverviewFilter = .all
    ) {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = tasks.filter { task in
            let matchesQuery = normalizedQuery.isEmpty || [
                task.title, task.goal, task.summary, task.currentAction,
                task.projectHint, task.assignedHostID
            ]
                .compactMap { $0 }
                .contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
            guard matchesQuery else { return false }
            switch filter {
            case .all: return true
            case .attention: return task.status == .waitingApproval || task.status == .failed
            case .active: return task.status.isActive
            case .proposed: return task.status == .proposed
            case .finished: return task.status.isTerminal
            }
        }
        let sorted = matching.sorted {
            if $0.isPinned != $1.isPinned { return $0.isPinned }
            return $0.updatedAt > $1.updatedAt
        }
        archived = sorted.filter(\.isArchived)
        let visible = sorted.filter { !$0.isArchived }
        pinned = visible.filter(\.isPinned)
        active = visible.filter { !$0.isPinned && $0.status.isActive }
        proposed = visible.filter { !$0.isPinned && $0.status == .proposed }
        finished = visible.filter { !$0.isPinned && $0.status.isTerminal }
    }
}

struct ShannonAgentTaskOverviewView: View {
    let model: ShannonConversationModel
    let openTask: (UUID) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var query = ""
    @State private var filter = ShannonAgentTaskOverviewFilter.all
    @State private var showsArchived = false

    private var projection: ShannonAgentTaskOverviewProjection {
        ShannonAgentTaskOverviewProjection(tasks: model.agentTasks, query: query, filter: filter)
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        List {
            Section {
                if projection.pinned.isEmpty,
                   projection.active.isEmpty,
                   projection.proposed.isEmpty,
                   projection.finished.isEmpty {
                    ContentUnavailableView(
                        query.isEmpty ? "作業はありません" : "一致する作業はありません",
                        systemImage: query.isEmpty ? "checkmark.circle" : "magnifyingglass",
                        description: Text(query.isEmpty
                            ? "会話でシャノンに作業を頼むと、ここに表示されます。"
                            : "検索語や絞り込みを変えてください。")
                    )
                    .frame(maxWidth: .infinity, minHeight: 240)
                    .listRowBackground(Color.clear)
                }
            } header: {
                overviewHeader(palette: palette)
            }

            taskSection("ピン留め", detail: "大切な作業", tasks: projection.pinned, palette: palette)
            taskSection("いま", detail: "進行・確認待ち・一時停止", tasks: projection.active, palette: palette)
            taskSection("これから", detail: "開始するかはあなたが決めます", tasks: projection.proposed, palette: palette)
            taskSection("完了", detail: "変更と検証結果", tasks: projection.finished, palette: palette)
        }
#if os(iOS)
        .listStyle(.insetGrouped)
#else
        .listStyle(.inset)
#endif
        .searchable(text: $query, prompt: "作業、プロジェクト、結果を検索")
        .scrollContentBackground(.hidden)
        .contentMargins(.top, ShannonSpacing.medium, for: .scrollContent)
        .contentMargins(.bottom, ShannonSpacing.huge, for: .scrollContent)
        .refreshable {
            await model.synchronizeAgentTasks()
            await model.refreshAgentWorkspace()
        }
        .background(palette.canvas)
        .sheet(isPresented: $showsArchived) {
            archivedTasksView(palette: palette)
        }
    }

    private func overviewHeader(palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text("作業全体")
                    .font(.largeTitle.bold())
                    .foregroundStyle(palette.textPrimary)
                    .textCase(nil)
                Text("目指していること、現在地、次の一手をまとめて確認できます。")
                    .font(.callout)
                    .foregroundStyle(palette.textSecondary)
                    .textCase(nil)
            }
            HStack {
                Menu {
                    Picker("表示", selection: $filter) {
                        ForEach(ShannonAgentTaskOverviewFilter.allCases) { value in
                            Text(value.title).tag(value)
                        }
                    }
                } label: {
                    Label(filter.title, systemImage: "line.3.horizontal.decrease.circle")
                }
                .buttonStyle(.bordered)

                Spacer()

                Button {
                    showsArchived = true
                } label: {
                    Label("アーカイブ", systemImage: "archivebox")
                }
                .buttonStyle(.bordered)
                .disabled(model.agentTasks.allSatisfy { !$0.isArchived })
            }
            .textCase(nil)
        }
        .padding(.bottom, ShannonSpacing.small)
    }

    @ViewBuilder
    private func taskSection(
        _ title: String,
        detail: String,
        tasks: [ShannonAgentTask],
        palette: ShannonPalette
    ) -> some View {
        if !tasks.isEmpty {
            Section {
                ForEach(tasks) { task in taskRow(task, palette: palette) }
            } header: {
                Text(title)
            } footer: {
                Text(detail)
            }
        }
    }

    private func taskRow(_ task: ShannonAgentTask, palette: ShannonPalette) -> some View {
        Button {
            openTask(task.id)
        } label: {
            HStack(alignment: .top, spacing: ShannonSpacing.medium) {
                Image(systemName: task.status.symbolName)
                    .foregroundStyle(task.status == .waitingApproval ? palette.attention : palette.brandPresence)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        if task.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(palette.textSecondary)
                        }
                        Text(task.title)
                            .font(.headline)
                            .foregroundStyle(palette.textPrimary)
                            .lineLimit(2)
                        Spacer(minLength: ShannonSpacing.small)
                        Text(task.status.japaneseName)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(palette.textSecondary)
                    }
                    Text(task.currentAction ?? task.summary)
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(2)
                    if let project = task.projectHint {
                        Label(project, systemImage: "folder")
                            .font(.caption)
                            .foregroundStyle(palette.textSecondary)
                    }
                    if let progress = task.progressFraction {
                        ProgressView(value: progress)
                            .tint(palette.action)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("作業の詳細と操作を開きます")
        .contextMenu {
            Button {
                Task { await model.toggleAgentTaskPinned(task.id) }
            } label: {
                Label(task.isPinned ? "ピン留めを外す" : "ピン留め", systemImage: task.isPinned ? "pin.slash" : "pin")
            }
            Button {
                Task { await model.setAgentTaskArchived(task.id, archived: true) }
            } label: {
                Label("アーカイブ", systemImage: "archivebox")
            }
            .disabled(task.status != .proposed && !task.status.isTerminal)
        }
    }

    private func archivedTasksView(palette: ShannonPalette) -> some View {
        NavigationStack {
            List {
                if projection.archived.isEmpty {
                    ContentUnavailableView("アーカイブはありません", systemImage: "archivebox")
                } else {
                    ForEach(projection.archived) { task in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(task.title).font(.headline)
                                Text(task.summary).font(.callout).foregroundStyle(palette.textSecondary).lineLimit(2)
                            }
                            Spacer()
                            Button("戻す") {
                                Task { await model.setAgentTaskArchived(task.id, archived: false) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("アーカイブ")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { showsArchived = false }
                }
            }
        }
#if os(macOS)
        .frame(minWidth: 420, minHeight: 420)
#else
        .presentationDetents([.medium, .large])
#endif
    }
}
