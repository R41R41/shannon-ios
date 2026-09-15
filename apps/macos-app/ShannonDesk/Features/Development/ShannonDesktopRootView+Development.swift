import AppKit
import ShannonAppCore
import SwiftUI

extension ShannonDesktopRootView {
    var developmentView: some View {
        VStack(spacing: 0) {
            developmentHeader
            Divider()

            HSplitView {
                developmentTaskList
                    .frame(minWidth: 220, idealWidth: 250, maxWidth: 320)
                VStack(spacing: 0) {
                    developmentToolPicker
                    Divider()
                    developmentToolContent
                }
                .frame(minWidth: 440)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .toolbar {
            Button {
                Task {
                    await conversation.synchronizeAgentTasks()
                    await conversation.refreshAgentWorkspace(projectHint: selectedAgentProject)
                    await conversation.refreshAgentProjectProvisioning()
                }
            } label: {
                Label("作業環境を更新", systemImage: "arrow.clockwise")
            }
        }
    }

    var developmentHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("開発")
                        .font(.title2.weight(.semibold))
                    Text("Codexを、安全なプロジェクト境界の中で動かします。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                DevelopmentRouteBadge(host: selectedDevelopmentHost)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    developmentProjectPicker
                    developmentHostPicker
                    developmentModelPicker
                    developmentReasoningPicker
                }

                VStack(spacing: 10) {
                    HStack(spacing: 12) {
                        developmentProjectPicker
                        developmentHostPicker
                    }
                    HStack(spacing: 12) {
                        developmentModelPicker
                        developmentReasoningPicker
                    }
                }
            }

            HStack(spacing: 7) {
                Image(systemName: selectedDevelopmentHost?.kind == .cloud ? "cloud" : "desktopcomputer")
                    .foregroundStyle(.secondary)
                Text(developmentRoutingExplanation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(selectedDevelopmentHost?.kind == .cloud ? "Codex API 従量課金" : "ChatGPT Codex 利用枠")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(selectedDevelopmentHost?.kind == .cloud ? Color.shannonAttention : .secondary)
            }

            if let provisioning = conversation.agentProjectProvisioning.first,
               provisioning.status != .ready {
                Label(
                    provisioning.errorMessage
                        ?? "\(provisioning.projectKey) · \(provisioning.status.japaneseName)",
                    systemImage: provisioning.status == .failed ? "exclamationmark.triangle" : "arrow.down.circle"
                )
                .font(.caption)
                .foregroundStyle(provisioning.status == .failed ? Color.shannonDanger : .secondary)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    var developmentProjectPicker: some View {
        HStack(spacing: 6) {
            Picker("プロジェクト", selection: $selectedAgentProject) {
                ForEach(developmentProjectKeys, id: \.self) { project in
                    Text(project).tag(project)
                }
            }
            .frame(minWidth: 150)
            .help("Agent Hostへ渡すプロジェクト")

            Button {
                showsAddAgentProject = true
            } label: {
                Label("GitHubリポジトリを追加", systemImage: "plus")
            }
            .labelStyle(.iconOnly)
            .help("GitHubリポジトリを安全な作業領域へ追加")
        }
    }

    var developmentHostPicker: some View {
        Picker("実行先", selection: Binding(
            get: { agentHostPreference },
            set: { agentHostPreference = $0 }
        )) {
            ForEach(ShannonAgentRoutingPreference.allCases) { preference in
                Text(preference.japaneseName).tag(preference)
            }
        }
        .frame(minWidth: 130)
        .help("自動はこのMacを優先し、利用できない場合だけクラウドへ切り替えます")
    }

    var developmentModelPicker: some View {
        Picker("モデル", selection: $selectedAgentModel) {
            Text("ホストの既定").tag("")
            ForEach(developmentModels) { model in
                Text(model.displayName).tag(model.id)
            }
        }
        .frame(minWidth: 180)
    }

    var developmentReasoningPicker: some View {
        Picker("思考", selection: Binding(
            get: { agentReasoningEffort },
            set: { agentReasoningEffort = $0 }
        )) {
            ForEach(availableReasoningEfforts) { effort in
                Text(effort.japaneseName).tag(effort)
            }
        }
        .frame(minWidth: 100)
    }

    var developmentTaskList: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("作業を検索", text: $developmentTaskSearchText)
                    .textFieldStyle(.roundedBorder)
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
            .listStyle(.sidebar)
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

    var developmentToolPicker: some View {
        Picker("開発ツール", selection: $selectedDevelopmentTool) {
            ForEach(DesktopDevelopmentTool.allCases) { tool in
                Label(tool.title, systemImage: tool.symbolName).tag(tool)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(12)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    var developmentToolContent: some View {
        if let task = selectedTask {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    developmentTaskSummary(task)
                    switch selectedDevelopmentTool {
                    case .files: DevelopmentFilesPane(project: selectedDevelopmentProject, task: task)
                    case .terminal:
                        DevelopmentTerminalPane(
                            task: task,
                            instruction: $developmentInstruction,
                            canSend: canSteerDevelopmentTask(task),
                            send: { sendDevelopmentInstruction(task) }
                        )
                    case .changes: DevelopmentChangesPane(project: selectedDevelopmentProject, task: task)
                    case .git:
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
                    case .build:
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
                    }
                }
                .frame(maxWidth: 880, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .top)
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
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.currentAction ?? task.summary).foregroundStyle(.secondary)
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
            }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label(task.title, systemImage: task.status.symbolName)
                .font(.headline)
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
