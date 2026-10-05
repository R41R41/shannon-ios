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
    /// The app's voice conversation (A16), shown in Talk over the composer.
    let voiceCall: ShannonDesktopVoiceCall
    /// This window, as the voice conversation counts the windows that can stop it.
    @State var windowID = UUID()
    /// This window's `NSWindow` (トークに戻る from the menu bar answers in the window it brought back).
    @State var hostWindow = DesktopWindowBox()

    @SceneStorage("shannon.desktop.destination") var restoredDestinationRawValue: String?
    @SceneStorage("shannon.desktop.selectedThread") var restoredThreadID: String?
    @SceneStorage("shannon.desktop.selectedTask") var restoredTaskID: String?
    @SceneStorage("shannon.desktop.showsInspector") var restoredInspectorRawValue: String?
    @SceneStorage("shannon.desktop.auxiliaryPanel") var restoredAuxiliaryPanelRawValue: String?
    @SceneStorage("shannon.desktop.shannonPage") var shannonPageRawValue: String?
    @SceneStorage("shannon.desktop.settingsPage") var settingsPageRawValue: String?
    @AppStorage(ShannonDesktopWindowRestoration.lastDestinationKey) var lastDestinationRawValue = DesktopDestination.talk.rawValue
    @AppStorage("shannon.desktop.lastSelectedThread") var lastRestoredThreadID = ""
    @AppStorage("shannon.desktop.lastSelectedTask") var lastRestoredTaskID = ""
    @AppStorage(ShannonDesktopWindowRestoration.lastInspectorVisibleKey) var lastShowsInspector = false
    @AppStorage(ShannonDesktopWindowRestoration.lastAuxiliaryPanelKey) var lastAuxiliaryPanelRawValue = DesktopAuxiliaryPanel.task.rawValue
    /// ようす and 運用 (the mark of 設定), read through the conversation's client and scope.
    @State var yousu: ShannonYousuModel
    @State var searchText = ""
    @State var selectedTaskID: UUID?
    @State var showsInspector = false
    @State var auxiliaryPanel = DesktopAuxiliaryPanel.task
    @State var requestedMessageJumpID: UUID?
    @State var requestedConversationAnchorID: String?
    @State var messageJumpRevision = 0
    @State var steeringText = ""
    @State var taskStopConfirmation: DesktopTaskStopConfirmation?
    @State var activeConversationOutlineEntryID: String?
    @State var showsConnection = false
    @State var showsWorldSubscriptions = false
    @State var showsAppIconSettings = false
    /// Her figure's shared state: what she does in words, her size and place, and touches (A15).
    @State var bodyModel = ShannonBodyModel()
    @State var showsStateDetails = false
    @AppStorage(ShannonChatAvatarStyle.storageKey) var chatAvatarStyleRawValue = ShannonChatAvatarStyle.expression.rawValue
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
    @FocusState var isThreadSearchFocused: Bool
    /// 設定 › 声: Gemini or ElevenLabs, read at the start of each voice conversation (A16).
    @AppStorage(ShannonSpeechProvider.storageKey) var speechProviderRawValue = ShannonSpeechProvider.gemini.rawValue
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceRawValue = ShannonAppearanceMode.system.rawValue
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.openWindow) var openWindow
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    public init(
        conversation: ShannonConversationModel,
        connection: ShannonConnectionModel,
        memory: ShannonMemoryModel,
        voiceIdentity: ShannonVoiceIdentityModel,
        worldSubscriptions: ShannonWorldSubscriptionModel,
        release: ShannonTestFlightDeliveryModel,
        appIcon: ShannonAppIconModel,
        voiceCall: ShannonDesktopVoiceCall
    ) {
        let defaults = UserDefaults.standard
        let initialChrome = ShannonDesktopWindowRestoration.windowChrome(
            sceneInspectorRawValue: nil,
            sceneAuxiliaryPanelRawValue: nil,
            lastInspectorVisible: defaults.object(
                forKey: ShannonDesktopWindowRestoration.lastInspectorVisibleKey
            ) as? Bool ?? false,
            lastAuxiliaryPanelRawValue: defaults.string(
                forKey: ShannonDesktopWindowRestoration.lastAuxiliaryPanelKey
            ) ?? DesktopAuxiliaryPanel.task.rawValue
        )
        _showsInspector = State(initialValue: initialChrome.showsInspector)
        _auxiliaryPanel = State(initialValue: initialChrome.auxiliaryPanel)
        _yousu = State(initialValue: ShannonYousuModel.make(for: conversation))
        self.conversation = conversation
        self.connection = connection
        self.memory = memory
        self.voiceIdentity = voiceIdentity
        self.worldSubscriptions = worldSubscriptions
        self.release = release
        self.appIcon = appIcon
        self.voiceCall = voiceCall
    }

    public var body: some View {
        observingWindowState(windowContent)
            .focusedSceneValue(\.shannonDesktopCommandActions, desktopCommandActions)
            .toolbarBackground(Color(nsColor: .textBackgroundColor), for: .windowToolbar)
            .toolbarBackground(.visible, for: .windowToolbar)
            .tint(shannonActionColor)
            // Wide screens use the fixed desktop scale, body 15 (owner decision 2026-10-03).
            .font(.shannonDesktop(.body))
            .frame(minWidth: 860, minHeight: 600)
    }

    private var windowContent: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 210, ideal: 244, max: 310)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .shannonOpensStudyPieces(with: memory.autonomy.study)
        // 「いま見ました」 when she looks through this Mac's camera in a conversation.
        .shannonAppLook(conversation)
        .inspector(isPresented: inspectorIsPresented) {
            auxiliaryInspector
                .inspectorColumnWidth(
                    min: auxiliaryPanel.minimumWidth, ideal: auxiliaryPanel.idealWidth, max: auxiliaryPanel.maximumWidth
                )
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
        // Her figure and touches, kept in step with the conversation (A15). Outside the inspector, so that
        // the 「すがた」 panel and 設定 › すがた read the same body model.
        .shannonBodyAttachment(bodyModel, conversation: conversation, memory: memory, voiceCall: voiceCall)
        // The call ends when its last window closes: nothing else on screen could stop it (A16).
        .onAppear {
            voiceCall.attach(conversation: conversation)
            voiceCall.windowAppeared(windowID)
            // トークに戻る with no window to bring back opens one on Talk.
            let openWindow = openWindow
            voiceCall.openTalkWindow = {
                UserDefaults.standard.set(DesktopDestination.talk.rawValue, forKey: ShannonDesktopWindowRestoration.lastDestinationKey)
                openWindow(id: "main")
            }
            // The four entries of the menu bar item (A17) with no window to bring back open one on that entry.
            ShannonDesktopBody.shared.openWindowForEntry = { entry in
                UserDefaults.standard.set(entry.rawValue, forKey: ShannonDesktopWindowRestoration.lastDestinationKey)
                openWindow(id: "main")
            }
        }
        .onDisappear { voiceCall.windowDisappeared(windowID) }
    }
}
