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

    @SceneStorage("shannon.desktop.destination") var restoredDestinationRawValue: String?
    @SceneStorage("shannon.desktop.selectedThread") var restoredThreadID: String?
    @SceneStorage("shannon.desktop.selectedTask") var restoredTaskID: String?
    @SceneStorage("shannon.desktop.showsInspector") var restoredInspectorRawValue: String?
    @AppStorage("shannon.desktop.lastDestination") var lastDestinationRawValue = DesktopDestination.talk.rawValue
    @AppStorage("shannon.desktop.lastSelectedThread") var lastRestoredThreadID = ""
    @AppStorage("shannon.desktop.lastSelectedTask") var lastRestoredTaskID = ""
    @AppStorage("shannon.desktop.lastShowsInspector") var lastShowsInspector = false
    @State var searchText = ""
    @State var selectedTaskID: UUID?
    @State var showsInspector = false
    @State var requestedMessageJumpID: UUID?
    @State var messageJumpRevision = 0
    @State var steeringText = ""
    @State var showsConversationOutline = false
    @State var showsConnection = false
    @State var showsWorldSubscriptions = false
    @State var renameThread: ChatThreadDTO?
    @State var renameText = ""
    @FocusState var focusedControl: ShannonDesktopFocusedControl?
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceRawValue = ShannonAppearanceMode.system.rawValue
    @Environment(\.colorScheme) var colorScheme

    public init(
        conversation: ShannonConversationModel,
        connection: ShannonConnectionModel,
        memory: ShannonMemoryModel,
        voiceIdentity: ShannonVoiceIdentityModel,
        worldSubscriptions: ShannonWorldSubscriptionModel
    ) {
        self.conversation = conversation
        self.connection = connection
        self.memory = memory
        self.voiceIdentity = voiceIdentity
        self.worldSubscriptions = worldSubscriptions
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
            taskInspector
                .inspectorColumnWidth(min: 260, ideal: 300, max: 390)
        }
        .sheet(isPresented: $showsConnection) {
            ShannonConnectionView(model: connection)
                .frame(minWidth: 520, minHeight: 500)
        }
        .sheet(isPresented: $showsWorldSubscriptions) {
            ShannonWorldSubscriptionView(model: worldSubscriptions)
                .frame(minWidth: 560, minHeight: 560)
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
            showsConversationOutline = false
        }
        .onChange(of: showsInspector) {
            restoredInspectorRawValue = showsInspector ? "visible" : "hidden"
            lastShowsInspector = showsInspector
        }
        .focusedSceneValue(\.shannonDesktopCommandActions, desktopCommandActions)
        .toolbarBackground(Color(nsColor: .textBackgroundColor), for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .tint(shannonActionColor)
        .frame(minWidth: 860, minHeight: 600)
    }
}
