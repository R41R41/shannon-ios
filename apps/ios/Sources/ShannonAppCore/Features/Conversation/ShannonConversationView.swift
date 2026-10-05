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
#if os(iOS)
    // The one voice conversation of the app: a call from Shannon runs it too, also with no screen (`ShannonVoiceCallHost`).
    @State var geminiLiveVoiceModel = ShannonVoiceCallHost.shared.voiceModel
#else
    @State var geminiLiveVoiceModel = ShannonGeminiLiveSessionModel()
#endif
    @State var bodyModel = ShannonBodyModel()
    @State var showsStateDetails = false
    @State var showsConnectionDetails = false
    @State var showsConnectedDevices = false
    @State var showsAppIconSettings = false
    @State var showsAppearanceSettings = false
    @State var showsTestFlightDelivery = false
    @State var showsVoiceDiagnostics = false
    @State var showsWorldSubscriptions = false
    @State var showsGeminiLiveVoice = false
    @State var showsSettings = false
    @State var showsThreadList = false
    @State var yousu: ShannonYousuModel
    @State var didApplyYousuPreview = false
    /// 「シャノン › ようす」 is open.
    @State var hubShowsYousu = false
    /// 「設定 › 管理 › 運用」 is open.
    @State var settingsShowsOps = false
    /// A `shannon://` link that waits until what is on screen lets its place be seen (`ShannonLinkRoute`).
    @State var deferredLink: ShannonDeferredLink?
    /// Set while Settings, asked for by a link, has not appeared yet; cleared when it appears or closes.
    @State var settingsLinkRequest: UUID?
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
    @State var voiceWorkspace = ShannonVoiceCallHost.shared.workspace
    @State var composerPhoto: ShannonPreparedPhoto?
    @State var composerPhotoPickerItem: PhotosPickerItem?
    @State var composerIsPickingPhoto = false
    @State var composerIsLoadingPhoto = false
#endif
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
    @AppStorage(ShannonChatAvatarStyle.storageKey) var chatAvatarStyleRawValue = ShannonChatAvatarStyle.expression.rawValue
    @AppStorage(ShannonSpeechProvider.storageKey) var speechProviderRawValue = ShannonSpeechProvider.gemini.rawValue
    @AppStorage(ShannonForm.storageKey) var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonBodyPreference.layoutModeKey) var figureLayoutRawValue = ShannonLive2DLayout.Mode.full.rawValue
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
        _yousu = State(initialValue: ShannonYousuModel.make(for: model))
    }

    public var body: some View {
        let activeColorScheme = resolvedColorScheme
        workspaceWithPresentations
        .modifier(ShannonBodyAttachment(bodyModel: bodyModel, conversation: model, memory: memoryModel, voice: geminiLiveVoiceModel, listen: bodyListen))
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
        // The marks on the top-left button: what waits for the owner in 「シャノン」, read when the app comes to the
        // front, and whether 運用 deserves a look, read then and every few minutes while the app stays in front.
        .task(id: scenePhase == .active) { await keepEntryMarks() }
        // The end of a call that did not get through (the network, or the app closed during it) is sent now.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active, !model.isDesignPreview else { return }
            ShannonVoiceCallPresence.shared.resendUndelivered(scopeKey: model.scopeKey, reporter: model.client as? any ShannonBodyCallReporting)
        }
        .onChange(of: showsSettings) {
            if !showsSettings {
                settingsShowsOps = false
                settingsLinkRequest = nil
            }
        }
        // Her figure in the dialogue display is the surface that may answer a touch in voice: only while it is what he sees.
        .onChange(of: dialogueFigureIsInFront, initial: true) { bodyModel.dialogueIsInFront = dialogueFigureIsInFront }
        .onChange(of: bodyModel.dialogueRequest) { showFigureInTalk() }
        // A new 映し方, from Talk's display options or 設定 › すがた, starts from her own size and place.
        .onChange(of: figureLayoutRawValue) { bodyModel.figureAdjustment = ShannonLive2DLayout() }
        .task {
            await loadInitialExperience(activeColorScheme: activeColorScheme)
        }
        // Whether there is a camera, once and off the main thread, before the camera's state is first shown.
        .task { await model.appLook.discoverCamera() }
        .shannonOpensStudyPieces(with: memoryModel.autonomy.study)
        .onAppear { openPendingYousuLink() }
        .onReceive(NotificationCenter.default.publisher(for: .shannonYousuLinkOpened)) { _ in openPendingYousuLink() }
        // A waiting link tries again whenever what is on screen changes, once it has settled.
        .task(id: linkRetryKey) { await retryDeferredLink() }
        // A work task he opened himself (from the call screen, say) is newer than a waiting link: the link gives way.
        .onChange(of: selectedAgentTaskID) { if selectedAgentTaskID != nil { deferredLink = nil } }
#if os(iOS)
        // With a friend in the call, earphones or not, the app does not say that only the owner can hear.
        .onChange(of: geminiLiveVoiceModel.othersMayBeListening, initial: true) {
            privateListening?.othersPresent = geminiLiveVoiceModel.othersMayBeListening
        }
        // Shannon's own messages, said through registered earphones (Settings › イヤホン; off until switched on).
        .modifier(ShannonPhoneEarphoneSpeaking(
            conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel, workspace: voiceWorkspace, dictation: voiceModel
        ))
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
                .onAppear { settingsLinkRequest = nil }
                .modifier(ShannonVoiceAccessoryModifier(workspace: voiceWorkspace,
                    conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel))
        }
#else
        .sheet(isPresented: $showsSettings) {
            settingsSheet
                .onAppear { settingsLinkRequest = nil }
        }
#endif
        .sheet(isPresented: $showsThreadList) {
            ShannonThreadListSheet(
                model: model,
                yousu: yousu,
                cameraOthersPresent: cameraOthersPresent,
                selectedThreadId: model.selectedThreadId,
                openTalk: openTalkFromThreadList,
                openWork: openWorkFromThreadList,
                openShannon: openShannonFromThreadList,
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
