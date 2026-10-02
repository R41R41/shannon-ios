import SwiftUI
#if canImport(UIKit)
import UIKit
import PhotosUI
#elseif canImport(AppKit)
import AppKit
#endif

public struct ShannonConversationView: View {
    @State var model: ShannonConversationModel
    @State var connectionModel: ShannonConnectionModel?
    @State var memoryModel: ShannonMemoryModel
    @State var testFlightDeliveryModel: ShannonTestFlightDeliveryModel
    @State var worldSubscriptionModel: ShannonWorldSubscriptionModel
    @State var appIconModel = ShannonAppIconModel()
    @State var voiceModel = ShannonVoiceConversationModel()
    @State var geminiLiveVoiceModel = ShannonGeminiLiveSessionModel()
    @State var showsStateDetails = false
    @State var showsConnectionDetails = false
    @State var showsAppIconSettings = false
    @State var showsAppearanceSettings = false
    @State var showsTestFlightDelivery = false
    @State var showsVoiceDiagnostics = false
    @State var showsWorldSubscriptions = false
    @State var showsGeminiLiveVoice = false
    @State var showsSettings = false
    @State var showsThreadList = false
    @State var selectedPage: ShannonWorkspacePage = .talk
    @State var displayMode: ShannonConversationDisplayMode = Self.savedDisplayMode
    @State var dialogueIsExpanded = false
    @State var dialogueDidCopy = false
    @State var dialogueActivity: ShannonDialogueActivity = .idle
    @State var selectedAgentTaskID: UUID?
    @State var composerAttachments: [ShannonChatAttachmentDTO] = []
    @State var composerUsesWebSearch = false
    @State var composerIsImporting = false
    @State var composerIsSubmitting = false
    @State var composerAttachmentError: String?
#if os(iOS)
    @State var voiceWorkspace = ShannonVoiceWorkspaceState()
    @State var composerPhoto: ShannonPreparedPhoto?
    @State var composerPhotoPickerItem: PhotosPickerItem?
    @State var composerIsPickingPhoto = false
    @State var composerIsLoadingPhoto = false
#endif
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
    @AppStorage(ShannonChatAvatarStyle.storageKey) var chatAvatarStyleRawValue = ShannonChatAvatarStyle.expression.rawValue
    @AppStorage(ShannonSpeechProvider.storageKey) var speechProviderRawValue = ShannonSpeechProvider.gemini.rawValue
    @FocusState var composerIsFocused: Bool

    @Environment(\.colorScheme) var colorScheme
    @Environment(\.dynamicTypeSize) var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @Environment(\.scenePhase) var scenePhase
    @Environment(ShannonPrivateListeningModel.self) var privateListening: ShannonPrivateListeningModel?

    public init(
        model: ShannonConversationModel = ShannonConversationModel(),
        connectionModel: ShannonConnectionModel? = nil,
        memoryModel: ShannonMemoryModel = ShannonMemoryModel(),
        testFlightDeliveryModel: ShannonTestFlightDeliveryModel = ShannonTestFlightDeliveryModel(),
        worldSubscriptionModel: ShannonWorldSubscriptionModel = ShannonWorldSubscriptionModel()
    ) {
        _model = State(initialValue: model)
        _connectionModel = State(initialValue: connectionModel)
        _memoryModel = State(initialValue: memoryModel)
        _testFlightDeliveryModel = State(initialValue: testFlightDeliveryModel)
        _worldSubscriptionModel = State(initialValue: worldSubscriptionModel)
    }

    public var body: some View {
        let activeColorScheme = resolvedColorScheme
        workspaceWithPresentations
        .environment(\.colorScheme, activeColorScheme)
        .onAppear {
            syncAppIconBadge(with: model.totalBadgeCount)
        }
        .onChange(of: model.totalBadgeCount) {
            syncAppIconBadge(with: model.totalBadgeCount)
        }
        .onChange(of: model.talkPresentationRevision) {
            closeThreadList()
            settleWorkspace(on: .talk)
        }
        .onChange(of: model.agentTaskPresentationRevision) {
            guard let taskID = model.requestedAgentTaskPresentationID else { return }
            openAgentTask(taskID)
        }
        .onChange(of: selectedPage) {
            handleSelectedPageChange()
        }
        .onChange(of: model.selectedThreadId) {
            resetComposerTools()
        }
        .onChange(of: scenePhase) {
            handleScenePhaseChange()
        }
        .onReceive(NotificationCenter.default.publisher(for: .shannonTestFlightDeliveryNotificationOpened)) { _ in
            showsSettings = true
            showsTestFlightDelivery = true
        }
        .task(id: "\(scenePhase)-\(model.agentTaskPollingKey)") {
            await pollAgentTasksWhileActive()
        }
        .task {
            await loadInitialExperience(activeColorScheme: activeColorScheme)
        }
        .shannonOpensStudyPieces(with: memoryModel.autonomy.study)
#if os(iOS)
        // With a friend in the call, earphones or not, the app does not say that only the owner can hear.
        .onChange(of: geminiLiveVoiceModel.othersMayBeListening, initial: true) {
            privateListening?.othersPresent = geminiLiveVoiceModel.othersMayBeListening
        }
#endif
#if DEBUG
        .onAppear { applyDesignPreviewLaunchState() }
#endif
    }

    private var workspaceShell: some View {
        let palette = ShannonPalette.resolve(resolvedColorScheme)
        return NavigationStack {
            workspaceContent(palette)
                .navigationTitle(workspaceNavigationTitle)
#if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
#endif
                .toolbar { workspaceToolbar }
        }
        .background { palette.canvas.ignoresSafeArea() }
        .foregroundStyle(palette.textPrimary)
        .tint(palette.action)
    }

    private var workspaceWithPresentations: some View {
        workspaceShell
#if os(iOS)
        .fullScreenCover(isPresented: $showsSettings) {
            settingsSheet
                .modifier(ShannonVoiceAccessoryModifier(workspace: voiceWorkspace,
                    conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel))
        }
#else
        .sheet(isPresented: $showsSettings) {
            settingsSheet
        }
#endif
        .sheet(isPresented: $showsThreadList) {
            ShannonThreadListSheet(
                model: model,
                selectedThreadId: model.selectedThreadId,
                openTalk: openTalkFromThreadList,
                openWork: openWorkFromThreadList,
                openMemory: openMemoryFromThreadList,
                openSettings: openSettingsFromThreadList,
                openAgentTask: openAgentTaskFromThreadList,
                close: closeThreadList
            )
#if os(iOS)
            .modifier(ShannonVoiceAccessoryModifier(workspace: voiceWorkspace,
                conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel))
            .presentationDetents([.large])
#endif
        }
#if os(iOS)
        .modifier(ShannonVoicePresentationModifier(
            isPresented: $showsGeminiLiveVoice,
            speechProvider: ShannonSpeechProvider(rawValue: speechProviderRawValue) ?? .gemini,
            workspace: voiceWorkspace,
            conversationModel: model,
            geminiVoiceModel: geminiLiveVoiceModel,
            expression: model.currentExpression,
            openTask: openAgentTask
        ))
        .fullScreenCover(isPresented: agentTaskRoomIsPresented) {
            agentTaskRoom
                .modifier(ShannonVoiceAccessoryModifier(workspace: voiceWorkspace,
                    conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel))
        }
#else
        .sheet(isPresented: agentTaskRoomIsPresented) {
            agentTaskRoom
                .frame(minWidth: 520, minHeight: 680)
        }
#endif
    }
}
