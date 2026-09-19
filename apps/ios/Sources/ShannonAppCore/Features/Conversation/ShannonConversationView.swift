import SwiftUI
#if canImport(UIKit)
import UIKit
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
    @State var composerAttachmentError: String?
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
    @FocusState var composerIsFocused: Bool

    @Environment(\.colorScheme) var colorScheme
    @Environment(\.dynamicTypeSize) var dynamicTypeSize
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

        NavigationStack {
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
        .onChange(of: scenePhase) {
            if scenePhase != .active {
                voiceModel.cancel()
                realtimeVoiceModel.stop()
                voiceIdentityModel.stopPreview()
                showsLiveVoice = false
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
        .sheet(isPresented: $showsThreadList) {
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
#if os(iOS)
            .presentationDetents([.large])
#endif
        }
        .onReceive(NotificationCenter.default.publisher(for: .shannonTestFlightDeliveryNotificationOpened)) { _ in
            showsSettings = true
            showsTestFlightDelivery = true
        }
#if os(iOS)
        .fullScreenCover(isPresented: $showsLiveVoice) {
            ShannonLiveVoiceView(
                model: realtimeVoiceModel,
                expression: model.currentExpression,
                createCall: { offer, participantMode in
                    try await model.createRealtimeVoiceCall(
                        offerSDP: offer,
                        participantMode: participantMode
                    )
                },
                performLiveDelegation: { transcript, participantMode in
                    try await model.performLiveVoiceDelegation(
                        transcript: transcript,
                        participantMode: participantMode
                    )
                },
                analyzeCameraSnapshot: { jpegData in
                    try await model.analyzeVoiceCameraSnapshot(jpegData: jpegData)
                },
                commitTurn: { user, shannon in
                    try await model.commitRealtimeVoiceTurn(
                        userTranscript: user,
                        shannonTranscript: shannon
                    )
                },
                dismiss: { showsLiveVoice = false }
            )
        }
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
