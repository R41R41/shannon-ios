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
    @State var voiceIdentityModel: ShannonVoiceIdentityModel
    @State var worldSubscriptionModel: ShannonWorldSubscriptionModel
    @State var appIconModel = ShannonAppIconModel()
    @State var voiceModel = ShannonVoiceConversationModel()
    @State var realtimeVoiceModel = ShannonRealtimeVoiceSessionModel()
    @State var showsStateDetails = false
    @State var showsConnectionDetails = false
    @State var showsAppIconSettings = false
    @State var showsAppearanceSettings = false
    @State var showsTestFlightDelivery = false
    @State var showsVoiceDiagnostics = false
    @State var showsVoiceIdentity = false
    @State var showsWorldSubscriptions = false
    @State var showsLiveVoice = false
    @State var showsGeminiVoice = false
    @State var showsVoiceModePicker = false
    @State var showsSettings = false
    @State var selectedPage: ShannonWorkspacePage = .talk
    @State var drawerProgress: CGFloat = 0
    @State var drawerDragIsActive = false
    @State var drawerDragStartProgress: CGFloat = 0
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
    @State var composerPhoto: ShannonPreparedPhoto?
    @State var composerPhotoPickerItem: PhotosPickerItem?
    @State var composerIsPickingPhoto = false
    @State var composerIsLoadingPhoto = false
#endif
    @State var conversationBottomOverlayHeight: CGFloat = ShannonWorkspaceChrome.contentBottomInset
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
    @AppStorage(ShannonChatAvatarStyle.storageKey) var chatAvatarStyleRawValue = ShannonChatAvatarStyle.expression.rawValue
    @FocusState var composerIsFocused: Bool

    @Environment(\.colorScheme) var colorScheme
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @Environment(\.scenePhase) var scenePhase

    public init(
        model: ShannonConversationModel = ShannonConversationModel(),
        connectionModel: ShannonConnectionModel? = nil,
        memoryModel: ShannonMemoryModel = ShannonMemoryModel(),
        testFlightDeliveryModel: ShannonTestFlightDeliveryModel = ShannonTestFlightDeliveryModel(),
        voiceIdentityModel: ShannonVoiceIdentityModel = ShannonVoiceIdentityModel(),
        worldSubscriptionModel: ShannonWorldSubscriptionModel = ShannonWorldSubscriptionModel()
    ) {
        _model = State(initialValue: model)
        _connectionModel = State(initialValue: connectionModel)
        _memoryModel = State(initialValue: memoryModel)
        _testFlightDeliveryModel = State(initialValue: testFlightDeliveryModel)
        _voiceIdentityModel = State(initialValue: voiceIdentityModel)
        _worldSubscriptionModel = State(initialValue: worldSubscriptionModel)
    }

    public var body: some View {
        let activeColorScheme = resolvedColorScheme
        let palette = ShannonPalette.resolve(activeColorScheme)

        GeometryReader { geometry in
            ZStack(alignment: .top) {
                workspaceContent(
                    palette,
                    bottomSafeAreaInset: geometry.safeAreaInsets.bottom
                )

                if selectedPage == .memory {
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        ShannonBottomReadabilityGradient(palette: palette)
                            .ignoresSafeArea(.container, edges: .bottom)
                    }
                    .allowsHitTesting(false)
                }

                ShannonTopReadabilityGradient(palette: palette)

                ShannonAppHeader(
                    selection: selectedPage,
                    unreadInitiativeCount: model.unreadInitiativeCount,
                    openThreadDrawer: openThreadDrawer,
                    createThread: createThreadFromHeader
                )
                .padding(.top, ShannonSpacing.extraSmall)

                Color.black.opacity(0.22 * drawerProgress)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { closeThreadDrawer() }
                    .allowsHitTesting(drawerProgress > 0.01)

                HStack(spacing: 0) {
                    ShannonThreadDrawer(
                        model: model,
                        selectedThreadId: model.selectedThreadId,
                        openTalk: openTalkFromDrawer,
                        openWork: openWorkFromDrawer,
                        openMemory: openMemoryFromDrawer,
                        openSettings: openSettingsFromDrawer,
                        openAgentTask: openAgentTaskFromDrawer,
                        close: closeThreadDrawer
                    )
                    .frame(width: drawerWidth(for: geometry.size.width))
                    .frame(maxHeight: .infinity)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .offset(x: -drawerWidth(for: geometry.size.width) * (1 - drawerProgress))
                .ignoresSafeArea(.container, edges: .all)
                .allowsHitTesting(drawerProgress > 0.98)
                .accessibilityHidden(drawerProgress < 0.98)
            }
            .simultaneousGesture(threadDrawerGesture(viewWidth: geometry.size.width))
        }
        .background { palette.canvas.ignoresSafeArea() }
        .foregroundStyle(palette.textPrimary)
        .tint(palette.action)
        .environment(\.colorScheme, activeColorScheme)
        .onAppear {
            syncAppIconBadge(with: model.totalBadgeCount)
        }
        .onChange(of: model.totalBadgeCount) {
            syncAppIconBadge(with: model.totalBadgeCount)
        }
        .onChange(of: model.talkPresentationRevision) {
            closeThreadDrawer()
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
        .onPreferenceChange(ShannonConversationBottomOverlayHeightKey.self) { height in
            guard height > 0 else { return }
            conversationBottomOverlayHeight = height
        }
        .onChange(of: scenePhase) {
            if scenePhase != .active {
                voiceModel.cancel()
                realtimeVoiceModel.stop()
                voiceIdentityModel.stopPreview()
                showsLiveVoice = false
                showsGeminiVoice = false
            }
        }
#if os(iOS)
        .fullScreenCover(isPresented: $showsSettings) {
            settingsSheet
        }
#else
        .sheet(isPresented: $showsSettings) {
            settingsSheet
        }
#endif
        .onReceive(NotificationCenter.default.publisher(for: .shannonTestFlightDeliveryNotificationOpened)) { _ in
            showsSettings = true
            showsTestFlightDelivery = true
        }
#if os(iOS)
        .modifier(ShannonVoicePresentationModifier(
            showsLiveVoice: $showsLiveVoice,
            showsGeminiVoice: $showsGeminiVoice,
            showsVoiceModePicker: $showsVoiceModePicker,
            conversationModel: model,
            voiceModel: voiceModel,
            realtimeVoiceModel: realtimeVoiceModel,
            expression: model.currentExpression
        ))
        .fullScreenCover(isPresented: agentTaskRoomIsPresented) {
            agentTaskRoom
        }
#else
        .sheet(isPresented: agentTaskRoomIsPresented) {
            agentTaskRoom
                .frame(minWidth: 520, minHeight: 680)
        }
#endif
        .task(id: "\(scenePhase)-\(model.agentTaskPollingKey)") {
            await pollAgentTasksWhileActive()
        }
        .onChange(of: model.currentExpression) {
            Task { await appIconModel.updateAutomatically(for: model.currentExpression) }
        }
        .onChange(of: activeColorScheme) {
            Task {
                await appIconModel.updateForAppearance(appIconAppearance(for: activeColorScheme))
            }
        }
        .task(id: appIconModel.nextRefreshAt) {
            await refreshAppIconAtNextDeadline()
        }
        .task {
            await loadInitialExperience(activeColorScheme: activeColorScheme)
        }
#if DEBUG
        .onAppear {
            applyDesignPreviewLaunchState()
        }
#endif
    }
}
