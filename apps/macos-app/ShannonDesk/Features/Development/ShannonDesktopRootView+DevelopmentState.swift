import ShannonAppCore
import SwiftUI

extension ShannonDesktopRootView {
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
