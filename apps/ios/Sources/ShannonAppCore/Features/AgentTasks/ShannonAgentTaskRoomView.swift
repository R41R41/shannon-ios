import SwiftUI

struct ShannonAgentTaskRoomView: View {
    let task: ShannonAgentTask
    let actionIsInFlight: Bool
    let actionError: String?
    let dismiss: () -> Void
    let dismissActionError: () -> Void
    let steer: (String) -> Void
    let togglePause: () -> Void
    let cancel: () -> Void
    let resolveApproval: (Bool, Bool) -> Void
    let workspace: ShannonAgentWorkspaceCatalogDTO
    let workspaceError: String?
    let refreshWorkspace: (String?) async -> Void
    let configureAndStart: (
        ShannonAgentRoutingPreference,
        String?,
        String?,
        ShannonAgentReasoningEffort?
    ) -> Void
    let advancePreview: (() -> Void)?

    @State var steerText = ""
    @State var showsCancelConfirmation = false
    @State var showsDetailedProgress = false
    @State var configurationProject = ""
    @State var configurationHost = ShannonAgentRoutingPreference.auto
    @State var configurationModel = ""
    @State var configurationReasoning = ShannonAgentReasoningEffort.high
    @State var didPrepareConfiguration = false
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            Group {
                if task.status == .proposed {
                    configurationForm(palette)
                } else {
                    progressView(palette)
                }
            }
            .navigationTitle(task.title)
            .modifier(AgentTaskRoomSubtitle(
                title: task.title,
                subtitle: ShannonAgentTaskRoomPresentation.subtitle(for: task),
                palette: palette
            ))
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる", systemImage: "xmark", action: dismiss)
                        .labelStyle(.iconOnly)
                }
                if task.status.isActive {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button(task.status == .paused ? "作業を再開" : "作業を一時停止",
                                   systemImage: task.status == .paused ? "play.fill" : "pause.fill",
                                   action: togglePause)
                                .disabled(actionIsInFlight || task.status == .waitingApproval)
                            Button("作業を中止", systemImage: "stop.fill", role: .destructive) {
                                showsCancelConfirmation = true
                            }
                            .disabled(actionIsInFlight)
                            if let advancePreview {
                                Divider()
                                Button("プレビューを次へ", systemImage: "forward.frame.fill", action: advancePreview)
                            }
                        } label: {
                            Label("作業操作", systemImage: "ellipsis.circle")
                        }
                    }
                }
            }
        }
        .confirmationDialog("シャノンの作業を中止しますか？", isPresented: $showsCancelConfirmation, titleVisibility: .visible) {
            Button("シャノンの作業を中止", role: .destructive) {
                cancel()
                dismiss()
            }
            Button("戻る", role: .cancel) {}
        } message: {
            Text("シャノンが完了した工程は残りますが、自動では再開しません。")
        }
        .task {
            prepareConfigurationIfNeeded()
            if task.status == .proposed {
                await refreshWorkspace(configurationProject.nilIfEmpty)
                normalizeConfiguration()
            }
        }
        .onChange(of: workspace) { normalizeConfiguration() }
        .onChange(of: configurationProject) { _, project in
            guard didPrepareConfiguration else { return }
            Task { await refreshWorkspace(project.nilIfEmpty) }
        }
        .onChange(of: configurationHost) { normalizeConfiguration() }
        .onChange(of: configurationModel) { normalizeConfiguration() }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: task.status)
    }

    static let topAnchor = "agent-task-room-top"

    func progressView(_ palette: ShannonPalette) -> some View {
        ZStack {
            palette.canvas.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    progressContent(palette)
                }
                .scrollIndicators(.hidden)
                .onChange(of: task.pendingApproval?.id) { _, approvalID in
                    // A newly arrived decision is brought into view even if the
                    // user had scrolled down to the plan or results.
                    guard approvalID != nil else { return }
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) {
                        proxy.scrollTo(Self.topAnchor, anchor: .top)
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if task.status.isActive {
                AgentTaskControlBar(
                    text: $steerText,
                    palette: palette,
                    isBusy: actionIsInFlight,
                    send: sendSteer
                )
            }
        }
    }

    /// Room order: decision (or status row), action error, plan, then the
    /// existing activity, history, and result blocks.
    func progressContent(_ palette: ShannonPalette) -> some View {
        LazyVStack(alignment: .leading, spacing: ShannonSpacing.extraLarge) {
            // A pending decision is always the first thing in the room;
            // otherwise a compact status row stands in for it.
            Group {
                if let approval = task.pendingApproval {
                    AgentTaskApprovalCard(
                        approval: approval,
                        palette: palette,
                        isSubmitting: actionIsInFlight,
                        acceptOnce: { resolveApproval(true, false) },
                        acceptForSession: { resolveApproval(true, true) },
                        decline: { resolveApproval(false, false) }
                    )
                } else {
                    AgentTaskStatusRow(task: task, palette: palette)
                }
            }
            .id(Self.topAnchor)

            if let actionError {
                AgentTaskActionErrorCard(
                    message: actionError,
                    palette: palette,
                    dismiss: dismissActionError
                )
            }

            if !task.plan.isEmpty {
                AgentTaskPlanSection(task: task, palette: palette)
            }

            if let command = task.latestCommandActivity {
                AgentTaskCommandActivityCard(event: command, palette: palette)
            }

            if !task.timeline.isEmpty {
                let recentEvents = Array(
                    task.timeline
                        .sorted(by: { $0.sequence < $1.sequence })
                        .suffix(3)
                )
                AgentTaskSection(title: "最新の動き", symbol: "clock", palette: palette) {
                    VStack(spacing: 0) {
                        ForEach(recentEvents) { event in
                            AgentTaskTimelineRow(
                                event: event,
                                showsConnector: event.id != recentEvents.last?.id,
                                palette: palette
                            )
                        }
                    }
                }
            }

            if !task.timeline.isEmpty {
                DisclosureGroup(isExpanded: $showsDetailedProgress) {
                    AgentTaskSection(title: "作業記録", symbol: "clock.arrow.circlepath", palette: palette) {
                        VStack(spacing: 0) {
                            let sortedEvents = task.timeline.sorted(by: { $0.sequence < $1.sequence })
                            ForEach(sortedEvents) { event in
                                AgentTaskTimelineRow(
                                    event: event,
                                    showsConnector: event.id != sortedEvents.last?.id,
                                    palette: palette
                                )
                            }
                        }
                    }
                    .padding(.top, ShannonSpacing.medium)
                } label: {
                    Label("全作業記録を表示", systemImage: "list.bullet")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(palette.textSecondary)
                }
                .tint(palette.action)
            }

            if !task.changes.isEmpty || !task.tests.isEmpty {
                AgentTaskResultSection(task: task, palette: palette)
            }
        }
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.top, ShannonSpacing.medium)
        .padding(.bottom, ShannonSpacing.huge)
    }

    func configurationForm(_ palette: ShannonPalette) -> some View {
        Form {
            Section {
                AgentTaskStatusRow(task: task, palette: palette)
            }

            Section {
                Picker("プロジェクト", selection: $configurationProject) {
                    Text("ホストの既定").tag("")
                    ForEach(configurationProjectKeys, id: \.self) { project in
                        Text(project).tag(project)
                    }
                }
                Picker("実行先", selection: $configurationHost) {
                    ForEach(ShannonAgentRoutingPreference.allCases) { preference in
                        Text(preference.japaneseName).tag(preference)
                    }
                }
                Picker("モデル", selection: $configurationModel) {
                    Text("ホストの既定").tag("")
                    ForEach(configurationModels) { model in
                        Text(model.displayName).tag(model.id)
                    }
                }
                Picker("思考", selection: $configurationReasoning) {
                    ForEach(configurationReasoningOptions) { effort in
                        Text(effort.japaneseName).tag(effort)
                    }
                }
            } header: {
                Text("作業環境")
            } footer: {
                Text(configurationRoutingExplanation)
            }

            if let workspaceError {
                Section {
                    Label(workspaceError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(palette.danger)
                }
            }

            Section {
                Button {
                    configureAndStart(
                        configurationHost,
                        configurationProject.nilIfEmpty,
                        configurationModel.nilIfEmpty,
                        configurationReasoning
                    )
                } label: {
                    HStack {
                        Spacer()
                        if actionIsInFlight { ProgressView().controlSize(.small) }
                        Text(actionIsInFlight ? "開始しています…" : "この設定で始める")
                        Spacer()
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(actionIsInFlight || !configurationCanStart)
            } footer: {
                Text("ファイル変更やコマンド実行で許可が必要になった場合は、実行前に確認します。")
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
    }

    func sendSteer() {
        let value = steerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        steer(value)
        steerText = ""
    }

    var configurationProjectKeys: [String] {
        let keys = workspace.projects.map(\.key)
        if keys.isEmpty, let project = task.projectHint?.nilIfEmpty { return [project] }
        return keys
    }

    var configurationHosts: [ShannonAgentHostDTO] {
        workspace.hosts.filter { host in
            configurationProject.isEmpty || host.projects.contains(configurationProject)
        }
    }

    var selectedConfigurationHost: ShannonAgentHostDTO? {
        ShannonAgentDevelopmentOptions.selectedHost(
            from: configurationHosts,
            preference: configurationHost,
            resolvedHostID: workspace.routing.resolvedHostId
        )
    }

    var configurationModels: [ShannonAgentModelDTO] {
        guard let host = selectedConfigurationHost, !host.models.isEmpty else { return workspace.models }
        return host.models
    }

    var configurationReasoningOptions: [ShannonAgentReasoningEffort] {
        guard let model = configurationModels.first(where: { $0.id == configurationModel }),
              !model.supportedReasoningEfforts.isEmpty else {
            return ShannonAgentReasoningEffort.allCases
        }
        return model.supportedReasoningEfforts
    }

    var configurationRoutingExplanation: String {
        if configurationHost == .auto {
            return workspace.routing.explanation
        }
        guard let host = selectedConfigurationHost else {
            return "選択した実行先では、このプロジェクトを利用できません。"
        }
        return "\(host.displayName)へ固定して実行します。"
    }

    var configurationCanStart: Bool {
        ShannonAgentWorkspaceAvailability.canStart(
            workspace: workspace,
            selectedHost: selectedConfigurationHost
        )
    }

    func prepareConfigurationIfNeeded() {
        guard !didPrepareConfiguration else { return }
        configurationProject = task.projectHint?.nilIfEmpty ?? workspace.projects.first?.key ?? ""
        configurationHost = task.hostHint.flatMap(ShannonAgentRoutingPreference.init(rawValue:))
            ?? workspace.routing.defaultPreference
        configurationModel = task.model?.nilIfEmpty ?? ""
        configurationReasoning = task.reasoningEffort ?? .high
        didPrepareConfiguration = true
        normalizeConfiguration()
    }

    func normalizeConfiguration() {
        if !configurationProject.isEmpty,
           !configurationProjectKeys.contains(configurationProject) {
            configurationProject = configurationProjectKeys.first ?? ""
            return
        }
        configurationModel = ShannonAgentDevelopmentOptions.normalizedModelID(
            configurationModel,
            models: configurationModels
        )
        configurationReasoning = ShannonAgentDevelopmentOptions.normalizedReasoningEffort(
            configurationReasoning,
            modelID: configurationModel,
            models: configurationModels
        )
    }
}

private extension String {
    var nilIfEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

struct AgentTaskSection<Content: View>: View {
    let title: String
    let symbol: String
    let palette: ShannonPalette
    let content: Content

    init(title: String, symbol: String, palette: ShannonPalette, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.palette = palette
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .foregroundStyle(palette.textPrimary)
            content
        }
    }
}
