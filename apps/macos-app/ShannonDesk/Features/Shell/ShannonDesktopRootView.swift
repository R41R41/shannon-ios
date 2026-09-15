import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

public struct ShannonDesktopRootView: View {
    @Bindable var conversation: ShannonConversationModel
    let connection: ShannonConnectionModel
    let memory: ShannonMemoryModel
    let voiceIdentity: ShannonVoiceIdentityModel
    let worldSubscriptions: ShannonWorldSubscriptionModel
    let release: ShannonTestFlightDeliveryModel
    let appIcon: ShannonAppIconModel

    @SceneStorage("shannon.desktop.destination") var restoredDestinationRawValue: String?
    @SceneStorage("shannon.desktop.selectedThread") var restoredThreadID: String?
    @SceneStorage("shannon.desktop.selectedTask") var restoredTaskID: String?
    @SceneStorage("shannon.desktop.showsInspector") var restoredInspectorRawValue: String?
    @SceneStorage("shannon.desktop.auxiliaryPanel") var restoredAuxiliaryPanelRawValue: String?
    @AppStorage("shannon.desktop.lastDestination") var lastDestinationRawValue = DesktopDestination.talk.rawValue
    @AppStorage("shannon.desktop.lastSelectedThread") var lastRestoredThreadID = ""
    @AppStorage("shannon.desktop.lastSelectedTask") var lastRestoredTaskID = ""
    @AppStorage("shannon.desktop.lastShowsInspector") var lastShowsInspector = false
    @AppStorage("shannon.desktop.lastAuxiliaryPanel") var lastAuxiliaryPanelRawValue = DesktopAuxiliaryPanel.task.rawValue
    @State var searchText = ""
    @State var selectedTaskID: UUID?
    @State var showsInspector = false
    @State var auxiliaryPanel = DesktopAuxiliaryPanel.task
    @State var requestedMessageJumpID: UUID?
    @State var requestedConversationAnchorID: String?
    @State var messageJumpRevision = 0
    @State var steeringText = ""
    @State var activeConversationOutlineEntryID: String?
    @State var showsConnection = false
    @State var showsWorldSubscriptions = false
    @State var showsAppIconSettings = false
    @State var renameThread: ChatThreadDTO?
    @State var renameText = ""
    @State var selectedDevelopmentTool = DesktopDevelopmentTool.initialValue
    @State var developmentTaskSearchText = ""
    @State var developmentTaskFilter = ShannonDesktopTaskFilter.all
    @State var showsArchivedDevelopmentTasks = false
    @State var developmentInstruction = ""
    @State var selectedDevelopmentFilePath: String?
    @State var developmentWorkspaceResource = ShannonDesktopWorkspaceResourceState.idle
    @State var showsAddAgentProject = false
    @State var agentRepositoryURL = ""
    @State var agentRepositoryKey = ""
    @AppStorage("shannon.desktop.agent.project") var selectedAgentProject = "shannon-ios"
    @AppStorage("shannon.desktop.agent.hostPreference") var agentHostPreferenceRawValue = ShannonAgentRoutingPreference.auto.rawValue
    @AppStorage("shannon.desktop.agent.model") var selectedAgentModel = ""
    @AppStorage("shannon.desktop.agent.reasoning") var agentReasoningRawValue = ShannonAgentReasoningEffort.high.rawValue
    @FocusState var focusedControl: ShannonDesktopFocusedControl?
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceRawValue = ShannonAppearanceMode.system.rawValue
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    public init(
        conversation: ShannonConversationModel,
        connection: ShannonConnectionModel,
        memory: ShannonMemoryModel,
        voiceIdentity: ShannonVoiceIdentityModel,
        worldSubscriptions: ShannonWorldSubscriptionModel,
        release: ShannonTestFlightDeliveryModel,
        appIcon: ShannonAppIconModel
    ) {
        self.conversation = conversation
        self.connection = connection
        self.memory = memory
        self.voiceIdentity = voiceIdentity
        self.worldSubscriptions = worldSubscriptions
        self.release = release
        self.appIcon = appIcon
    }

    public var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 210, ideal: 244, max: 310)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .inspector(isPresented: $showsInspector) {
            auxiliaryInspector
                .inspectorColumnWidth(min: 230, ideal: 286, max: 390)
        }
        .sheet(isPresented: $showsConnection) {
            ShannonConnectionView(model: connection)
                .frame(minWidth: 520, minHeight: 500)
        }
        .sheet(isPresented: $showsWorldSubscriptions) {
            ShannonWorldSubscriptionView(model: worldSubscriptions)
                .frame(minWidth: 560, minHeight: 560)
        }
        .sheet(isPresented: $showsAppIconSettings) {
            ShannonAppIconSettingsView(model: appIcon)
        }
        .sheet(isPresented: $showsAddAgentProject) {
            DevelopmentAddRepositorySheet(
                repositoryURL: $agentRepositoryURL,
                projectKey: $agentRepositoryKey,
                hostPreference: agentHostPreference,
                isAdding: conversation.isProvisioningAgentProject,
                errorMessage: conversation.agentProjectProvisioningError,
                cancel: { showsAddAgentProject = false },
                add: addAgentRepository
            )
        }
        .alert("トークタイトルを変更", isPresented: renameAlertBinding) {
            TextField("タイトル", text: $renameText)
            Button("キャンセル", role: .cancel) { renameThread = nil }
            Button("保存") { saveThreadRename() }
                .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .task {
            restoreWindowChromeIfAvailable()
            if connection.isConnected && !conversation.isDesignPreview {
                await connection.verifyConnection()
            }
            await conversation.loadConversationIfNeeded()
            await restoreSelectedThreadIfAvailable()
            if !conversation.isDesignPreview {
                await conversation.synchronizeAgentTasks()
                await conversation.refreshAgentWorkspace(projectHint: selectedAgentProject)
                await conversation.refreshAgentProjectProvisioning()
                await conversation.refreshInitiatives()
            }
            restoreSelectedTaskIfAvailable()
            if !conversation.isDesignPreview {
                await voiceIdentity.reload()
            }
        }
        .task(id: connection.isConnected) {
            guard connection.isConnected, !conversation.isDesignPreview else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                await conversation.refreshInitiatives()
            }
        }
        .onChange(of: conversation.agentTasks.map(\.id)) {
            restoreSelectedTaskIfAvailable()
        }
        .onChange(of: selectedTaskID) {
            steeringText = ""
            if let selectedTaskID {
                restoredTaskID = selectedTaskID.uuidString
                lastRestoredTaskID = selectedTaskID.uuidString
            }
        }
        .onChange(of: conversation.selectedThreadId) {
            restoredThreadID = conversation.selectedThreadId
            lastRestoredThreadID = conversation.selectedThreadId ?? ""
            activeConversationOutlineEntryID = nil
        }
        .onChange(of: showsInspector) {
            restoredInspectorRawValue = showsInspector ? "visible" : "hidden"
            lastShowsInspector = showsInspector
        }
        .onChange(of: auxiliaryPanel) {
            restoredAuxiliaryPanelRawValue = auxiliaryPanel.rawValue
            lastAuxiliaryPanelRawValue = auxiliaryPanel.rawValue
        }
        .onChange(of: selectedAgentProject) {
            selectedDevelopmentFilePath = nil
            developmentWorkspaceResource = .idle
            guard !conversation.isDesignPreview else { return }
            Task { await conversation.refreshAgentWorkspace(projectHint: selectedAgentProject) }
        }
        .onChange(of: agentHostPreferenceRawValue) {
            normalizeDevelopmentSelection()
        }
        .onChange(of: conversation.agentWorkspace) {
            normalizeDevelopmentSelection()
        }
        .onChange(of: selectedDevelopmentTool) {
            developmentWorkspaceResource = .idle
        }
        .focusedSceneValue(\.shannonDesktopCommandActions, desktopCommandActions)
        .toolbarBackground(Color(nsColor: .textBackgroundColor), for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .tint(shannonActionColor)
        .frame(minWidth: 860, minHeight: 600)
    }
}
