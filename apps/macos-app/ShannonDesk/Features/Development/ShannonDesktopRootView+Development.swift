import AppKit
import ShannonAppCore
import SwiftUI

extension ShannonDesktopRootView {
    var developmentView: some View {
        VStack(spacing: 0) {
            developmentStatusBar
            Divider()
            GeometryReader { proxy in
                if ShannonDesktopDevelopmentLayout.showsTaskNavigator(availableWidth: proxy.size.width) {
                    HSplitView {
                        developmentTaskList
                            .frame(minWidth: 200, idealWidth: 240, maxWidth: 300)
                        developmentWorkspace
                            .frame(minWidth: 360)
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                } else {
                    VStack(spacing: 0) {
                        developmentCompactTaskBar
                        Divider()
                        developmentWorkspace
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .navigationTitle("開発")
        .toolbar {
            ToolbarItemGroup(placement: .automatic) {
                developmentProjectMenu
                developmentExecutionMenu
                developmentModelMenu
            }
            ToolbarItem(placement: .primaryAction) {
                Button(action: refreshDevelopmentWorkspace) {
                    Label("作業環境を更新", systemImage: "arrow.clockwise")
                }
                .help("タスクと作業環境を更新")
            }
        }
    }

    var developmentCompactTaskBar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                developmentTaskMenu
                TextField("作業を検索", text: $developmentTaskSearchText)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 240)
                developmentTaskFilterMenu
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    developmentTaskMenu
                    Spacer()
                    developmentTaskFilterMenu
                }
                TextField("作業を検索", text: $developmentTaskSearchText)
                    .textFieldStyle(.roundedBorder)
            }
        }
        .padding(10)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    var developmentTaskMenu: some View {
        Menu {
            Picker("作業", selection: $selectedTaskID) {
                ForEach(visibleDevelopmentTasks) { task in
                    Label(task.title, systemImage: task.status.symbolName)
                        .tag(Optional(task.id))
                }
            }
        } label: {
            Label(selectedTask?.title ?? "作業を選択", systemImage: selectedTask?.status.symbolName ?? "list.bullet")
                .lineLimit(1)
        }
        .disabled(visibleDevelopmentTasks.isEmpty)
        .help("開発作業を選択")
    }

    var developmentTaskFilterMenu: some View {
        Menu {
            Picker("表示", selection: $developmentTaskFilter) {
                ForEach(ShannonDesktopTaskFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            Divider()
            Toggle("アーカイブを表示", isOn: $showsArchivedDevelopmentTasks)
        } label: {
            Label("絞り込み", systemImage: "line.3.horizontal.decrease.circle")
        }
        .labelStyle(.iconOnly)
        .help("\(developmentTaskFilter.title)・アーカイブ\(showsArchivedDevelopmentTasks ? "表示" : "非表示")")
    }

    var developmentTaskList: some View {
        VStack(spacing: 0) {
            HStack {
                Label("作業", systemImage: "list.bullet")
                    .font(.headline)
                Spacer()
                developmentTaskFilterMenu
            }
            .padding(.horizontal, 10)
            .padding(.top, 10)

            HStack(spacing: 8) {
                TextField("作業を検索", text: $developmentTaskSearchText)
                    .textFieldStyle(.roundedBorder)
            }
            .padding(10)

            Divider()

            List(selection: $selectedTaskID) {
                if workProjection.pinned.isEmpty && workProjection.active.isEmpty
                    && workProjection.proposed.isEmpty && workProjection.finished.isEmpty {
                    Text("会話から開発を依頼すると、ここに作業が表示されます。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                }
                if !workProjection.pinned.isEmpty {
                    Section("ピン留め") {
                        ForEach(workProjection.pinned) { task in developmentTaskRow(task) }
                    }
                }
                if !workProjection.active.isEmpty {
                    Section("進行中") {
                        ForEach(workProjection.active) { task in developmentTaskRow(task) }
                    }
                }
                if !workProjection.proposed.isEmpty {
                    Section("開始前") {
                        ForEach(workProjection.proposed) { task in developmentTaskRow(task) }
                    }
                }
                if !workProjection.finished.isEmpty {
                    Section("終了") {
                        ForEach(workProjection.finished) { task in developmentTaskRow(task) }
                    }
                }
                if showsArchivedDevelopmentTasks && !workProjection.archived.isEmpty {
                    Section("アーカイブ") {
                        ForEach(workProjection.archived) { task in developmentTaskRow(task) }
                    }
                }
            }
            .listStyle(.inset)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    func developmentTaskRow(_ task: ShannonAgentTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(task.title)
                .lineLimit(2)
            HStack(spacing: 5) {
                Image(systemName: task.status.symbolName)
                    .foregroundStyle(task.status.isTerminal ? Color.secondary : shannonActionColor)
                Text(task.status.japaneseName)
                if let project = task.projectHint, !project.isEmpty {
                    Text("· \(project)")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .tag(task.id)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(task.title)
        .accessibilityValue([task.status.japaneseName, task.projectHint].compactMap { $0 }.joined(separator: "、"))
        .contextMenu {
            Button(task.isPinned ? "ピン留めを外す" : "ピン留め") {
                Task { await conversation.toggleAgentTaskPinned(task.id) }
            }
            Button(task.isArchived ? "アーカイブから戻す" : "アーカイブ") {
                Task { await conversation.setAgentTaskArchived(task.id, archived: !task.isArchived) }
            }
            .disabled(!task.isArchived && task.status != .proposed && !task.status.isTerminal)
        }
    }

    var developmentWorkspace: some View {
        VStack(spacing: 0) {
            developmentToolPicker
            Divider()
            developmentToolContent
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    var developmentToolPicker: some View {
        HStack(spacing: 12) {
            Picker("開発ツール", selection: $selectedDevelopmentTool) {
                ForEach(DesktopDevelopmentTool.allCases) { tool in
                    Label(tool.title, systemImage: tool.symbolName).tag(tool)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 520)
            Spacer(minLength: 0)
            if let task = selectedTask {
                Label(task.status.japaneseName, systemImage: task.status.symbolName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("作業状態、\(task.status.japaneseName)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    var developmentToolContent: some View {
        if let task = selectedTask {
            VStack(spacing: 0) {
                developmentTaskSummary(task)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                Divider()

                switch selectedDevelopmentTool {
                case .files:
                    DevelopmentFilesPane(
                        project: selectedDevelopmentProject,
                        task: task,
                        selectedPath: $selectedDevelopmentFilePath,
                        resource: developmentWorkspaceResource,
                        load: loadDevelopmentWorkspaceResource
                    )
                case .changes:
                    DevelopmentChangesPane(
                        project: selectedDevelopmentProject,
                        task: task,
                        selectedPath: $selectedDevelopmentFilePath,
                        resource: developmentWorkspaceResource,
                        load: loadDevelopmentWorkspaceResource
                    )
                case .terminal:
                    ScrollView {
                        DevelopmentTerminalPane(
                            task: task,
                            instruction: $developmentInstruction,
                            canSend: canSteerDevelopmentTask(task),
                            send: { sendDevelopmentInstruction(task) }
                        )
                        .frame(maxWidth: 880, alignment: .leading)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .top)
                    }
                case .git:
                    ScrollView {
                        DevelopmentGitPane(
                            project: selectedDevelopmentProject,
                            task: task,
                            host: selectedDevelopmentHost,
                            canRequest: canSteerDevelopmentTask(task),
                            requestBranch: {
                                steerDevelopmentTask(
                                    task,
                                    instruction: "現在の変更を保ったまま、この作業専用の安全なGitブランチまたはworktreeを用意してください。"
                                )
                            }
                        )
                        .frame(maxWidth: 880, alignment: .leading)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .top)
                    }
                case .build:
                    ScrollView {
                        DevelopmentBuildPane(
                            task: task,
                            canRequest: canSteerDevelopmentTask(task),
                            requestBuild: {
                                steerDevelopmentTask(
                                    task,
                                    instruction: "このプロジェクトの標準的なビルドと関連テストを実行し、結果を検証欄へ整理してください。"
                                )
                            }
                        )
                        .frame(maxWidth: 880, alignment: .leading)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .top)
                    }
                }
            }
        } else {
            ContentUnavailableView(
                "開発作業を選択",
                systemImage: selectedDevelopmentTool.symbolName,
                description: Text("会話で開発を依頼するか、左の作業を選んでください。")
            )
        }
    }

    func developmentTaskSummary(_ task: ShannonAgentTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Label(task.title, systemImage: task.status.symbolName)
                        .font(.headline)
                    Text(task.currentAction ?? task.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                if task.status == .proposed {
                    Button("この設定で開始") {
                        configureAndStartDevelopmentTask(task)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(conversation.isAgentTaskActionInFlight(task.id) || !developmentCanStart)
                }
            }
            if let progress = task.progressFraction {
                ProgressView(value: progress)
                    .accessibilityLabel("作業進捗")
                    .accessibilityValue("\(Int(progress * 100))パーセント")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var visibleDevelopmentTasks: [ShannonAgentTask] {
        workProjection.pinned
            + workProjection.active
            + workProjection.proposed
            + workProjection.finished
            + (showsArchivedDevelopmentTasks ? workProjection.archived : [])
    }

    var developmentModelLabel: String {
        guard !selectedAgentModel.isEmpty,
              let model = developmentModels.first(where: { $0.id == selectedAgentModel }) else {
            return "モデル"
        }
        return model.displayName
    }

    var developmentHostSymbol: String {
        switch agentHostPreference {
        case .auto: "point.3.connected.trianglepath.dotted"
        case .local: "desktopcomputer"
        case .cloud: "cloud"
        }
    }

    var developmentBillingLabel: String {
        selectedDevelopmentHost?.kind == .cloud ? "API従量課金" : "Codex利用枠"
    }

    var developmentBillingSymbol: String {
        selectedDevelopmentHost?.kind == .cloud ? "creditcard" : "checkmark.circle"
    }

    var developmentBillingColor: Color {
        selectedDevelopmentHost?.kind == .cloud ? .shannonAttention : .secondary
    }

    func refreshDevelopmentWorkspace() {
        Task {
            await conversation.synchronizeAgentTasks()
            await conversation.refreshAgentWorkspace(projectHint: selectedAgentProject)
            await conversation.refreshAgentProjectProvisioning()
        }
    }

    var developmentProjectKeys: [String] {
        let keys = conversation.agentWorkspace.projects.map(\.key)
        return keys.isEmpty ? [selectedAgentProject] : keys
    }

    var availableReasoningEfforts: [ShannonAgentReasoningEffort] {
        guard let model = developmentModels.first(where: { $0.id == selectedAgentModel }),
              !model.supportedReasoningEfforts.isEmpty else {
            return ShannonAgentReasoningEffort.allCases
        }
        return model.supportedReasoningEfforts
    }

    var selectedDevelopmentHost: ShannonAgentHostDTO? {
        let hosts = conversation.agentWorkspace.hosts.filter { host in
            host.projects.contains(selectedAgentProject)
        }
        switch agentHostPreference {
        case .auto:
            return hosts.first { $0.hostId == conversation.agentWorkspace.routing.resolvedHostId }
        case .local:
            return hosts.first { $0.kind == .local }
        case .cloud:
            return hosts.first { $0.kind == .cloud }
        }
    }

    var selectedDevelopmentProject: ShannonAgentProjectDTO? {
        conversation.agentWorkspace.projects.first { $0.key == selectedAgentProject }
    }

    var developmentModels: [ShannonAgentModelDTO] {
        guard let host = selectedDevelopmentHost, !host.models.isEmpty else {
            return conversation.agentWorkspace.models
        }
        return host.models
    }

    var developmentRoutingExplanation: String {
        if agentHostPreference == .auto { return conversation.agentWorkspace.routing.explanation }
        guard let host = selectedDevelopmentHost else {
            return "選択した実行先では、このプロジェクトを利用できません。"
        }
        return "\(host.displayName)へ固定して実行します。"
    }

    var developmentCanStart: Bool {
        ShannonAgentWorkspaceAvailability.canStart(
            workspace: conversation.agentWorkspace,
            selectedHost: selectedDevelopmentHost
        )
    }

    func configureAndStartDevelopmentTask(_ task: ShannonAgentTask) {
        conversation.configureAgentTask(
            task.id,
            hostPreference: agentHostPreference,
            projectHint: selectedAgentProject,
            model: selectedAgentModel.isEmpty ? nil : selectedAgentModel,
            reasoningEffort: agentReasoningEffort
        )
        Task { await conversation.startAgentTask(task.id) }
    }

    func normalizeDevelopmentSelection() {
        let projects = conversation.agentWorkspace.projects
        if !projects.isEmpty, !projects.contains(where: { $0.key == selectedAgentProject }) {
            selectedAgentProject = projects[0].key
            return
        }
        let normalizedModelID = ShannonDesktopDevelopmentOptions.normalizedModelID(
            selectedAgentModel,
            models: developmentModels
        )
        if normalizedModelID != selectedAgentModel {
            selectedAgentModel = normalizedModelID
        }
        let normalizedEffort = ShannonDesktopDevelopmentOptions.normalizedReasoningEffort(
            agentReasoningEffort,
            modelID: normalizedModelID,
            models: developmentModels
        )
        if normalizedEffort != agentReasoningEffort {
            agentReasoningEffort = normalizedEffort
        }
    }

    func canSteerDevelopmentTask(_ task: ShannonAgentTask) -> Bool {
        task.status == .running || task.status == .paused
    }

    func sendDevelopmentInstruction(_ task: ShannonAgentTask) {
        let instruction = developmentInstruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return }
        developmentInstruction = ""
        steerDevelopmentTask(task, instruction: instruction)
    }

    func steerDevelopmentTask(_ task: ShannonAgentTask, instruction: String) {
        Task { await conversation.steerAgentTask(task.id, instruction: instruction) }
    }

    func addAgentRepository() {
        let input = ShannonDesktopRepositoryInput(
            repositoryURL: agentRepositoryURL,
            projectKey: agentRepositoryKey
        )
        guard input.isValid else { return }
        Task {
            let added = await conversation.provisionAgentProject(
                repositoryURL: input.repositoryURL,
                projectKey: input.projectKey,
                hostPreference: agentHostPreference
            )
            guard added else { return }
            selectedAgentProject = input.projectKey
            agentRepositoryURL = ""
            agentRepositoryKey = ""
            showsAddAgentProject = false
        }
    }
}
