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
    @State var selectedPage: ShannonWorkspacePage = .talk
    @State var drawerProgress: CGFloat = 0
    @State var drawerDragIsActive = false
    @State var drawerDragStartProgress: CGFloat = 0
    @State var displayMode: ShannonConversationDisplayMode = Self.savedDisplayMode
    @State var dialogueIsExpanded = false
    @State var dialogueDidCopy = false
    @State var dialoguePresenceIsBreathing = false
    @State var selectedAgentTaskID: UUID?
    @AppStorage(ShannonAppearanceMode.storageKey) var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
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
        let palette = M3Palette.resolve(activeColorScheme)

        GeometryReader { geometry in
            ZStack(alignment: .top) {
                workspaceContent(palette)

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
                .padding(.top, M3Spacing.extraSmall)

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
        .background { palette.surface.ignoresSafeArea() }
        .foregroundStyle(palette.onSurface)
        .tint(palette.primary)
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
            composerIsFocused = false
            voiceModel.cancel()
            realtimeVoiceModel.stop()
            showsLiveVoice = false
            guard selectedPage == .memory else { return }
            Task { await memoryModel.reload() }
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
        .onReceive(NotificationCenter.default.publisher(for: .shannonTestFlightDeliveryNotificationOpened)) { _ in
            showsSettings = true
            showsTestFlightDelivery = true
        }
#if os(iOS)
        .fullScreenCover(isPresented: $showsLiveVoice) {
            ShannonLiveVoiceView(
                model: realtimeVoiceModel,
                expression: model.currentExpression,
                createCall: { offer in
                    try await model.createRealtimeVoiceCall(offerSDP: offer)
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
            guard scenePhase == .active, !model.agentTaskPollingKey.isEmpty else { return }
            while !Task.isCancelled {
                await model.synchronizeAgentTasks()
                guard !model.agentTaskPollingKey.isEmpty else { return }
                do {
                    try await Task.sleep(for: .seconds(2))
                } catch {
                    return
                }
            }
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
            guard let refreshAt = appIconModel.nextRefreshAt else { return }
            let delay = max(0, refreshAt.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await appIconModel.updateAutomatically(for: model.currentExpression)
        }
        .task {
            guard !model.isDesignPreview else { return }
            connectionModel?.refreshFromKeychain()
            await model.loadConversationIfNeeded()
            await model.refreshInitiatives()
            await appIconModel.activate(
                for: model.currentExpression,
                appearance: appIconAppearance(for: activeColorScheme)
            )
            await voiceIdentityModel.reload()
        }
#if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewSettings") {
                showsSettings = true
            }
            if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewDrawer") {
                drawerProgress = 1
            }
        }
#endif
    }
}
