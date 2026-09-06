import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct ShannonConversationView: View {
    @State private var model: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel?
    @State private var memoryModel: ShannonMemoryModel
    @State private var testFlightDeliveryModel: ShannonTestFlightDeliveryModel
    @State private var appIconModel = ShannonAppIconModel()
    @State private var voiceModel = ShannonVoiceConversationModel()
    @State private var realtimeVoiceModel = ShannonRealtimeVoiceSessionModel()
    @State private var showsStateDetails = false
    @State private var showsConnectionDetails = false
    @State private var showsAppIconSettings = false
    @State private var showsAppearanceSettings = false
    @State private var showsTestFlightDelivery = false
    @State private var showsVoiceDiagnostics = false
    @State private var showsLiveVoice = false
    @State private var showsSettings = false
    @State private var selectedPage: ShannonWorkspacePage = .talk
    @State private var drawerProgress: CGFloat = 0
    @State private var drawerDragIsActive = false
    @State private var drawerDragStartProgress: CGFloat = 0
    @State private var displayMode: ShannonConversationDisplayMode = Self.savedDisplayMode
    @State private var dialogueIsExpanded = false
    @State private var dialogueDidCopy = false
    @State private var dialoguePresenceIsBreathing = false
    @State private var selectedAgentTaskID: UUID?
    @AppStorage(ShannonAppearanceMode.storageKey) private var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
    @FocusState private var composerIsFocused: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    public init(
        model: ShannonConversationModel = ShannonConversationModel(),
        connectionModel: ShannonConnectionModel? = nil,
        memoryModel: ShannonMemoryModel = ShannonMemoryModel(),
        testFlightDeliveryModel: ShannonTestFlightDeliveryModel = ShannonTestFlightDeliveryModel()
    ) {
        _model = State(initialValue: model)
        _connectionModel = State(initialValue: connectionModel)
        _memoryModel = State(initialValue: memoryModel)
        _testFlightDeliveryModel = State(initialValue: testFlightDeliveryModel)
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        GeometryReader { geometry in
            ZStack(alignment: .top) {
                workspaceContent(palette)

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
            .clipped()
            .simultaneousGesture(threadDrawerGesture(viewWidth: geometry.size.width))
        }
        .background(palette.surface)
        .foregroundStyle(palette.onSurface)
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
                showsLiveVoice = false
            }
        }
        .sheet(isPresented: $showsSettings) {
            settingsSheet(palette)
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
        .task(id: appIconModel.nextRefreshAt) {
            guard let refreshAt = appIconModel.nextRefreshAt else { return }
            let delay = max(0, refreshAt.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await appIconModel.updateAutomatically(for: model.currentExpression)
        }
        .task {
            connectionModel?.refreshFromKeychain()
            await model.loadConversationIfNeeded()
            await model.refreshInitiatives()
            await appIconModel.activate(for: model.currentExpression)
        }
    }

    private func workspaceContent(_ palette: M3Palette) -> some View {
        ZStack {
            talkPage(palette)
                .opacity(selectedPage == .talk ? 1 : 0)
                .allowsHitTesting(selectedPage == .talk)
                .accessibilityHidden(selectedPage != .talk)
            ShannonMemoryView(
                model: memoryModel,
                showsDismissButton: false,
                workspaceTopInset: ShannonWorkspaceChrome.contentTopInset
            )
            .opacity(selectedPage == .memory ? 1 : 0)
            .allowsHitTesting(selectedPage == .memory)
            .accessibilityHidden(selectedPage != .memory)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: selectedPage)
    }

    private func talkPage(_ palette: M3Palette) -> some View {
        ZStack {
            Group {
                switch displayMode {
                case .scroll:
                    messageList(palette)
                case .dialogue:
                    dialogueStage(palette)
                }
            }

            VStack {
                HStack {
                    Spacer()
                    Button(action: toggleDisplayMode) {
                        Label(displayMode.switchActionTitle, systemImage: displayMode.switchActionSymbolName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(.horizontal, M3Spacing.medium)
                            .frame(minHeight: 38)
                            .background(.thinMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(displayMode.switchActionTitle)表示へ切り替える")
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.top, ShannonWorkspaceChrome.contentTopInset)
                Spacer()
            }
        }
        .overlay(alignment: .bottom) {
            ZStack(alignment: .bottom) {
                ShannonBottomReadabilityGradient(palette: palette)
                    .ignoresSafeArea(.container, edges: .bottom)
                    .allowsHitTesting(false)

                VStack(spacing: M3Spacing.small) {
                    if let statusMessage = model.statusMessage {
                        ShannonSnackbar(
                            message: statusMessage,
                            showsRetry: false,
                            retry: {},
                            dismiss: model.dismissStatus
                        )
                        .padding(.horizontal, M3Spacing.large)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if let errorMessage = model.errorMessage {
                        ShannonSnackbar(
                            message: errorMessage,
                            showsRetry: model.hasFailedMessage,
                            retry: { Task { await model.retryLastFailed() } },
                            dismiss: model.dismissError
                        )
                        .padding(.horizontal, M3Spacing.large)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if let task = model.latestAgentTaskNotice {
                        ShannonAgentTaskCapsule(task: task) {
                            openAgentTask(task.id)
                        }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    composer(palette)
                }
            }
        }
        .background(palette.surface)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
    }

    private func messageList(_ palette: M3Palette) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: M3Spacing.medium) {
                    if model.isLoadingHistory {
                        ProgressView("これまでの会話を思い出している…")
                            .tint(palette.primary)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(.top, 72)
                    } else if model.messages.isEmpty {
                        ShannonEmptyConversation()
                    }

                    ForEach(ShannonConversationTimeline.items(from: model.messages)) { item in
                        switch item {
                        case .day(let day):
                            ShannonConversationDayDivider(day: day)
                        case .message(let message):
                            if message.id == latestShannonMessageID,
                               let reference = model.latestContextReference {
                                ShannonContextReferenceCard(memory: reference)
                            }
                            ShannonMessageRow(
                                message: message,
                                isSendingToAether: model.aetherProposalMessageIDs.contains(message.id),
                                wasSentToAether: model.aetherSubmittedMessageIDs.contains(message.id),
                                sendToAether: { Task { await model.sendToAether(message) } }
                            )
                                .id(message.id)
                            if let task = model.agentTask(sourceMessageID: message.id) {
                                ShannonAgentTaskCardView(
                                    task: task,
                                    start: { Task { await model.startAgentTask(task.id) } },
                                    cancel: { Task { await model.cancelAgentTask(task.id) } },
                                    open: { openAgentTask(task.id) }
                                )
                                .id("agent-task-\(task.id.uuidString)")
                            }
                        }
                    }

                    ForEach(model.unattachedSelectedThreadAgentTasks) { task in
                        ShannonAgentTaskCardView(
                            task: task,
                            start: { Task { await model.startAgentTask(task.id) } },
                            cancel: { Task { await model.cancelAgentTask(task.id) } },
                            open: { openAgentTask(task.id) }
                        )
                        .id("restored-agent-task-\(task.id.uuidString)")
                    }

                    if model.isSending {
                        ShannonTypingIndicator(expression: model.currentExpression)
                            .id("shannon-is-typing")
                    }

                    Color.clear.frame(height: 1).id("conversation-bottom")
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.top, ShannonWorkspaceChrome.contentTopInset)
                .padding(.bottom, ShannonWorkspaceChrome.contentBottomInset)
            }
            .scrollIndicators(.hidden)
            .shannonKeyboardDismissMode()
            .background(Color.clear)
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded { composerIsFocused = false })
            .onChange(of: model.messages.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: model.isSending) {
                scrollToBottom(proxy)
            }
        }
        .ignoresSafeArea(.container, edges: [.top, .bottom])
    }

    private func composer(_ palette: M3Palette) -> some View {
        HStack(alignment: .bottom, spacing: M3Spacing.extraSmall) {
            TextField("メッセージ", text: $model.draft, axis: .vertical)
                .font(.body)
                .lineLimit(1...5)
                .frame(minHeight: 40)
                .focused($composerIsFocused)
                .padding(.leading, M3Spacing.medium)
                .padding(.vertical, M3Spacing.small)
                .onSubmit { sendDraft() }
                .submitLabel(.send)
                .accessibilityHint("複数行入力できます")

            Button(action: composerPrimaryAction) {
                ZStack {
                    Circle()
                        .fill(composerActionIsEnabled ? palette.primary : palette.surface)
                    if model.isSending || voiceModel.phase == .requestingPermission || voiceModel.phase == .thinking {
                        ProgressView()
                            .tint(palette.onSurfaceVariant)
                            .controlSize(.small)
                    } else {
                        Image(systemName: composerActionSymbol)
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(composerActionIsEnabled ? palette.onPrimary : palette.onSurfaceVariant)
                    }
                }
                .frame(width: 40, height: 40)
            }
            .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            .buttonStyle(.plain)
            .disabled(!composerActionIsEnabled)
            .accessibilityLabel(composerActionLabel)
        }
        .padding(M3Spacing.extraSmall)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.extraLarge, style: .continuous)
                .stroke(composerIsFocused ? palette.primary : palette.outlineVariant, lineWidth: composerIsFocused ? 2 : 0.7)
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.top, M3Spacing.small)
        .padding(.bottom, M3Spacing.small)
    }

    private func settingsSheet(_ palette: M3Palette) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.large) {
                    Button { showsStateDetails = true } label: {
                        ShannonSettingsRow(
                            title: "シャノンの状態",
                            detail: model.state == nil
                                ? model.currentExpression.japaneseName
                                : "\(model.currentExpression.japaneseName)・v\(model.state?.version ?? 0)",
                            symbol: "waveform.path.ecg"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsAppIconSettings = true } label: {
                        ShannonSettingsRow(
                            title: "アプリアイコン",
                            detail: "\(appIconModel.mode.japaneseName)・\(appIconModel.activeTitle)",
                            symbol: "app.dashed"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsAppearanceSettings = true } label: {
                        ShannonSettingsRow(
                            title: "外観",
                            detail: savedAppearanceMode.japaneseName,
                            symbol: savedAppearanceMode.symbolName
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsTestFlightDelivery = true } label: {
                        ShannonSettingsRow(
                            title: "アプリの更新",
                            detail: "TestFlightの配信状況と履歴",
                            symbol: "arrow.down.app"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsVoiceDiagnostics = true } label: {
                        ShannonSettingsRow(
                            title: "音声診断",
                            detail: "クラッシュ直前の処理を確認・コピー",
                            symbol: "waveform.badge.magnifyingglass"
                        )
                    }
                    .buttonStyle(.plain)

                    if let connectionModel {
                        Button { showsConnectionDetails = true } label: {
                            ShannonSettingsRow(
                                title: "接続",
                                detail: connectionModel.statusLabel,
                                symbol: "link"
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.vertical, M3Spacing.large)
            }
            .scrollIndicators(.hidden)
            .background(palette.surface)
            .navigationTitle("設定")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { showsSettings = false }
                }
            }
            .sheet(isPresented: $showsStateDetails) {
                ShannonStateSheet(state: model.state, expression: model.currentExpression)
            }
            .sheet(isPresented: $showsConnectionDetails) {
                if let connectionModel {
                    ShannonConnectionView(model: connectionModel)
                }
            }
            .sheet(isPresented: $showsAppIconSettings) {
                ShannonAppIconSettingsView(
                    model: appIconModel,
                    expression: model.currentExpression
                )
            }
            .sheet(isPresented: $showsAppearanceSettings) {
                ShannonAppearanceSettingsView()
            }
            .sheet(isPresented: $showsTestFlightDelivery) {
                ShannonTestFlightDeliveryView(model: testFlightDeliveryModel)
            }
            .sheet(isPresented: $showsVoiceDiagnostics) {
                ShannonVoiceDiagnosticsView()
            }
        }
    }

    private func threadDrawerGesture(viewWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .local)
            .onChanged { value in
                if !drawerDragIsActive {
                    guard ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
                        isTalkSelected: selectedPage == .talk,
                        composerIsFocused: composerIsFocused,
                        currentProgress: drawerProgress,
                        startX: value.startLocation.x,
                        translation: value.translation
                    ) else { return }
                    drawerDragStartProgress = drawerProgress
                    drawerDragIsActive = true
                }

                drawerProgress = ShannonWorkspaceMotionPolicy.drawerProgress(
                    from: drawerDragStartProgress,
                    translation: value.translation.width,
                    drawerWidth: drawerWidth(for: viewWidth)
                )
            }
            .onEnded { value in
                guard drawerDragIsActive else { return }
                drawerDragIsActive = false
                settleDrawer(open: ShannonWorkspaceMotionPolicy.shouldOpenDrawer(
                    from: drawerDragStartProgress,
                    predictedTranslation: value.predictedEndTranslation.width,
                    drawerWidth: drawerWidth(for: viewWidth)
                ))
            }
    }

    private func settleWorkspace(on page: ShannonWorkspacePage) {
        let changed = page != selectedPage
        composerIsFocused = false
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.34, extraBounce: 0.04)) {
            selectedPage = page
        }
        if changed { ShannonHaptics.page() }
    }

    private func openThreadDrawer() {
        guard !composerIsFocused else {
            composerIsFocused = false
            return
        }
        settleDrawer(open: true)
    }

    private func createThreadFromHeader() {
        guard !composerIsFocused else {
            composerIsFocused = false
            return
        }
        settleWorkspace(on: .talk)
        Task { await model.createThread(title: nil) }
    }

    private func openTalkFromDrawer() {
        settleWorkspace(on: .talk)
        closeThreadDrawer()
        Task { await model.acknowledgeVisibleInitiatives() }
    }

    private func openMemoryFromDrawer() {
        settleWorkspace(on: .memory)
        closeThreadDrawer()
    }

    private func openSettingsFromDrawer() {
        closeThreadDrawer()
        openSettings()
    }

    private func openAgentTaskFromDrawer(_ id: UUID) {
        closeThreadDrawer()
        openAgentTask(id)
    }

    private func openSettings() {
        guard !composerIsFocused else {
            composerIsFocused = false
            return
        }
        showsSettings = true
        ShannonHaptics.page()
    }

    private func closeThreadDrawer() {
        settleDrawer(open: false)
    }

    private func syncAppIconBadge(with count: Int) {
#if canImport(UIKit)
        let clamped = min(max(0, count), 99)
        UIApplication.shared.applicationIconBadgeNumber = clamped
#endif
    }

    private func settleDrawer(open: Bool) {
        let wasOpen = drawerProgress > 0.5
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.32, extraBounce: 0.03)) {
            drawerProgress = open ? 1 : 0
        }
        if open != wasOpen { ShannonHaptics.drawer() }
    }

    private func drawerWidth(for viewWidth: CGFloat) -> CGFloat {
        min(viewWidth * 0.80, 360)
    }

    private func dialogueStage(_ palette: M3Palette) -> some View {
        GeometryReader { geometry in
            let keyboardScale: CGFloat = composerIsFocused ? 0.84 : 1
            let portraitWidth = min(geometry.size.width * 1.04, 430) * keyboardScale

            ZStack(alignment: .top) {
                LinearGradient(
                    colors: [
                        palette.surface,
                        palette.primaryContainer.opacity(colorScheme == .dark ? 0.26 : 0.42),
                        palette.surface
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()

                Circle()
                    .fill(palette.primary.opacity(colorScheme == .dark ? 0.12 : 0.08))
                    .frame(width: geometry.size.width * 1.28, height: geometry.size.width * 1.28)
                    .blur(radius: 42)
                    .position(x: geometry.size.width / 2, y: geometry.size.height * 0.50)

                ShannonDialogueStagePortraitView()
                    .frame(width: portraitWidth)
                    .scaleEffect(dialoguePresenceIsBreathing && !reduceMotion ? 1.008 : 1)
                    .shadow(color: palette.primary.opacity(0.10), radius: 28, y: 10)
                    .position(
                        x: geometry.size.width / 2,
                        y: geometry.size.height * (composerIsFocused ? 0.59 : 0.62)
                    )
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.24), value: composerIsFocused)
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: 3.2).repeatForever(autoreverses: true),
                        value: dialoguePresenceIsBreathing
                    )

                VStack(spacing: M3Spacing.small) {
                    HStack(spacing: 6) {
                        Text("シャノン")
                            .font(.callout.weight(.semibold))
                        Text("·")
                        Text(model.currentExpression.japaneseName)
                    }
                    .foregroundStyle(palette.onSurfaceVariant)
                    .padding(.horizontal, M3Spacing.medium)
                    .frame(minHeight: 32)
                    .background(.thinMaterial, in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("シャノン、\(model.currentExpression.japaneseName)")

                    if let userMessage = latestUserMessage {
                        Text("あなた：\(userMessage.text)")
                            .font(.caption)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .lineLimit(1)
                            .padding(.horizontal, M3Spacing.medium)
                            .frame(maxWidth: 330, minHeight: 30, alignment: .trailing)
                            .background(.ultraThinMaterial, in: Capsule())
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .padding(.horizontal, M3Spacing.large)
                    }

                    if model.isSending {
                        ShannonDialogueBubble(palette: palette, isExpanded: false) {
                            ShannonThinkingDots()
                        }
                        .transition(.opacity)
                    } else if let reply = model.messages.last(where: { $0.role == .shannon }) {
                        ShannonDialogueBubble(palette: palette, isExpanded: dialogueIsExpanded) {
                            VStack(alignment: .leading, spacing: M3Spacing.extraSmall) {
                                ScrollView(dialogueIsExpanded ? .vertical : []) {
                                    Text(reply.text)
                                        .font(.body)
                                        .lineSpacing(2)
                                        .foregroundStyle(palette.onSurface)
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .scrollIndicators(.hidden)
                                .frame(maxHeight: dialogueIsExpanded ? min(250, geometry.size.height * 0.34) : 104)

                                HStack(spacing: M3Spacing.extraSmall) {
                                    if reply.text.count > 120 {
                                        Button {
                                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.24)) {
                                                dialogueIsExpanded.toggle()
                                            }
                                        } label: {
                                            Label(
                                                dialogueIsExpanded ? "閉じる" : "続きを読む",
                                                systemImage: dialogueIsExpanded ? "chevron.up" : "chevron.down"
                                            )
                                            .font(.caption2.weight(.medium))
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(palette.onSurfaceVariant)
                                    }
                                    Spacer(minLength: 0)
                                    Button {
                                        copyDialogueReply(reply.text)
                                    } label: {
                                        Label(
                                            dialogueDidCopy ? "コピー済み" : "コピー",
                                            systemImage: dialogueDidCopy ? "checkmark" : "doc.on.doc"
                                        )
                                        .font(.caption2.weight(.semibold))
                                        .frame(minHeight: 30)
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(palette.onSurfaceVariant)
                                    .accessibilityLabel(dialogueDidCopy ? "コピーしました" : "シャノンの回答をコピー")
                                }
                            }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, ShannonWorkspaceChrome.contentTopInset + 48)
                .padding(.bottom, M3Spacing.large)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { composerIsFocused = false }
        .onAppear { dialoguePresenceIsBreathing = true }
        .onDisappear { dialoguePresenceIsBreathing = false }
        .onChange(of: model.messages.count) { dialogueIsExpanded = false }
    }

    private func toggleDisplayMode() {
        guard !composerIsFocused else {
            composerIsFocused = false
            return
        }
        displayMode = displayMode == .scroll ? .dialogue : .scroll
        UserDefaults.standard.set(displayMode.rawValue, forKey: Self.displayModeKey)
        composerIsFocused = false
        ShannonHaptics.page()
    }

    private func copyDialogueReply(_ text: String) {
#if canImport(UIKit)
        UIPasteboard.general.string = text
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#endif
        dialogueDidCopy = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            dialogueDidCopy = false
        }
    }

    private static let displayModeKey = "shannon.conversation.display-mode"
    private static var savedDisplayMode: ShannonConversationDisplayMode {
        UserDefaults.standard.string(forKey: displayModeKey)
            .flatMap(ShannonConversationDisplayMode.init(rawValue:)) ?? .scroll
    }

    private var savedAppearanceMode: ShannonAppearanceMode {
        ShannonAppearanceMode(rawValue: appearanceModeRawValue) ?? .system
    }

    private var latestShannonMessageID: UUID? {
        model.messages.last(where: { $0.role == .shannon })?.id
    }

    private var latestUserMessage: ConversationMessage? {
        model.messages.last(where: { $0.role == .user })
    }

    private var agentTaskRoomIsPresented: Binding<Bool> {
        Binding(
            get: { selectedAgentTaskID != nil },
            set: { isPresented in
                if !isPresented { selectedAgentTaskID = nil }
            }
        )
    }

    @ViewBuilder
    private var agentTaskRoom: some View {
        if let selectedAgentTaskID,
           let task = model.agentTask(id: selectedAgentTaskID) {
            ShannonAgentTaskRoomView(
                task: task,
                actionIsInFlight: model.isAgentTaskActionInFlight(task.id),
                actionError: model.agentTaskActionError(task.id),
                dismiss: { self.selectedAgentTaskID = nil },
                dismissActionError: { model.dismissAgentTaskActionError(task.id) },
                steer: { instruction in Task { await model.steerAgentTask(task.id, instruction: instruction) } },
                togglePause: { Task { await model.toggleAgentTaskPause(task.id) } },
                cancel: { Task { await model.cancelAgentTask(task.id) } },
                resolveApproval: { accepted, forSession in
                    Task {
                        await model.resolveAgentApproval(task.id, accepted: accepted, forSession: forSession)
                    }
                },
                advancePreview: nil
            )
        }
    }

    private func sendDraft() {
        voiceModel.stopSpeaking()
        guard model.canSendDraft else { return }
        Task { await model.sendDraft() }
    }

    private var composerActionIsEnabled: Bool {
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return model.canSendDraft
        }
        return !model.isSending
    }

    private var composerActionSymbol: String {
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "arrow.up" }
        return "waveform"
    }

    private var composerActionLabel: String {
        if model.isSending { return "送信中" }
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "送信" }
        return "シャノンと音声で話す"
    }

    private func composerPrimaryAction() {
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sendDraft()
            return
        }
        performVoicePrimaryAction()
    }

    private func performVoicePrimaryAction() {
        composerIsFocused = false
        voiceModel.cancel()
        showsLiveVoice = true
    }

    private func openAgentTask(_ id: UUID) {
        model.acknowledgeAgentTask(id)
        selectedAgentTaskID = id
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
            proxy.scrollTo("conversation-bottom", anchor: .bottom)
        }
    }

}

private struct ShannonAppIconSettingsView: View {
    let model: ShannonAppIconModel
    let expression: ShannonExpressionDTO

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.large) {
                    HStack(spacing: M3Spacing.large) {
                        ShannonAppIconPreview(
                            assetName: previewAssetName(for: model.activeChoice ?? .primary),
                            size: 76,
                            accessibilityLabel: "現在のアイコン"
                        )
                        VStack(alignment: .leading, spacing: 3) {
                            Text("現在のアイコン")
                                .font(.caption)
                                .foregroundStyle(palette.onSurfaceVariant)
                            Text(model.activeTitle)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(palette.onSurface)
                            Text(model.mode.japaneseName)
                                .font(.subheadline)
                                .foregroundStyle(palette.onSurfaceVariant)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(M3Spacing.large)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
                    .overlay {
                        RoundedRectangle(cornerRadius: M3Shape.large)
                            .stroke(palette.outlineVariant, lineWidth: 0.7)
                    }

                    Text("変更方法")
                        .font(.headline)
                        .foregroundStyle(palette.onSurface)

                    VStack(spacing: M3Spacing.small) {
                        ForEach(ShannonAppIconMode.allCases) { mode in
                            Button {
                                Task {
                                    await model.selectMode(mode, expression: expression)
                                }
                            } label: {
                                HStack(spacing: M3Spacing.medium) {
                                    modePreview(for: mode)

                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(mode.japaneseName)
                                            .font(.body.weight(.semibold))
                                        Text(modeDetail(for: mode))
                                            .font(.caption)
                                            .foregroundStyle(palette.onSurfaceVariant)
                                            .multilineTextAlignment(.leading)
                                    }
                                    .foregroundStyle(palette.onSurface)

                                    Spacer(minLength: M3Spacing.small)

                                    Image(systemName: model.mode == mode ? "checkmark.circle.fill" : "circle")
                                        .font(.title3)
                                        .foregroundStyle(
                                            model.mode == mode
                                                ? palette.primary
                                                : palette.outlineVariant
                                        )
                                }
                                .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
                                .padding(.horizontal, M3Spacing.medium)
                                .padding(.vertical, M3Spacing.small)
                                .background(
                                    model.mode == mode
                                        ? palette.primaryContainer
                                        : palette.surface,
                                    in: RoundedRectangle(cornerRadius: M3Shape.large)
                                )
                                .overlay {
                                    RoundedRectangle(cornerRadius: M3Shape.large)
                                        .stroke(
                                            model.mode == mode
                                                ? palette.primary
                                                : palette.outlineVariant,
                                            lineWidth: model.mode == mode ? 2 : 0.7
                                        )
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(model.isUpdating)
                        }
                    }

                    if model.mode == .manual {
                        iconChoiceGrid(
                            title: "アイコン",
                            choices: ShannonAppIconChoice.manualChoices,
                            palette: palette
                        )
                    }

                    if model.isUpdating {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    }

                    if let errorMessage = model.errorMessage {
                        ShannonSnackbar(
                            message: errorMessage,
                            showsRetry: false,
                            retry: {},
                            dismiss: model.dismissError
                        )
                    }
                }
                .padding(M3Spacing.large)
            }
            .background(palette.surfaceContainerLow)
            .navigationTitle("アプリアイコン")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func modePreview(for mode: ShannonAppIconMode) -> some View {
        switch mode {
        case .automatic:
            ZStack(alignment: .leading) {
                ForEach(Array(automaticPreviewChoices.enumerated()), id: \.element.id) { index, choice in
                    ShannonAppIconPreview(
                        assetName: choice.previewAssetName,
                        size: 42,
                        accessibilityLabel: "\(choice.japaneseName)のアイコン"
                    )
                    .offset(x: CGFloat(index) * 11)
                    .zIndex(Double(automaticPreviewChoices.count - index))
                }
            }
            .frame(width: 66, height: 56, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("時刻と感情で変わるアイコン")
        case .manual:
            ShannonAppIconPreview(
                assetName: previewAssetName(for: model.manualChoice),
                size: 56,
                accessibilityLabel: "選択中の\(model.manualChoice.japaneseName)アイコン"
            )
        }
    }

    private var automaticPreviewChoices: [ShannonAppIconChoice] {
        let preferred = model.mode == .automatic
            ? model.activeChoice ?? ShannonAppIconChoice.matching(expression)
            : ShannonAppIconChoice.matching(expression)
        return [preferred, .sleepy, .sleeping].reduce(into: []) { choices, choice in
            if !choices.contains(choice) {
                choices.append(choice)
            }
        }
    }

    private func modeDetail(for mode: ShannonAppIconMode) -> String {
        switch mode {
        case .automatic:
            "時刻とシャノンの感情で変化"
        case .manual:
            "\(model.manualChoice.japaneseName)を使用"
        }
    }

    @ViewBuilder
    private func iconChoiceGrid(
        title: String,
        choices: [ShannonAppIconChoice],
        palette: M3Palette
    ) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(palette.onSurface)

        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: M3Spacing.small),
                GridItem(.flexible(), spacing: M3Spacing.small),
            ],
            spacing: M3Spacing.small
        ) {
            ForEach(choices) { choice in
                Button {
                    Task { await model.selectManualChoice(choice) }
                } label: {
                    VStack(spacing: M3Spacing.small) {
                        ShannonAppIconPreview(
                            assetName: previewAssetName(for: choice),
                            size: 72,
                            accessibilityLabel: "\(choice.japaneseName)のアイコン"
                        )
                        Text(choice.japaneseName)
                            .font(.callout.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(
                        model.manualChoice == choice
                            ? palette.onPrimaryContainer
                            : palette.onSurface
                    )
                    .frame(maxWidth: .infinity, minHeight: 122)
                    .background(
                        model.manualChoice == choice
                            ? palette.primaryContainer
                            : palette.surface,
                        in: RoundedRectangle(cornerRadius: M3Shape.large)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: M3Shape.large)
                            .stroke(
                                model.manualChoice == choice
                                    ? palette.primary
                                    : palette.outlineVariant,
                                lineWidth: model.manualChoice == choice ? 2 : 0.7
                            )
                    }
                }
                .buttonStyle(.plain)
                .disabled(model.isUpdating)
            }
        }
    }

    private func previewAssetName(for choice: ShannonAppIconChoice) -> String {
        guard choice == .primary else { return choice.previewAssetName }
        return colorScheme == .dark
            ? ShannonAppIconAssets.primaryDarkPreviewAssetName
            : ShannonAppIconAssets.primaryLightPreviewAssetName
    }
}

private struct ShannonAppIconPreview: View {
    let assetName: String
    let size: CGFloat
    let accessibilityLabel: String

    var body: some View {
        previewImage
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                    .stroke(.black.opacity(0.08), lineWidth: 0.7)
            }
            .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
            .accessibilityLabel(accessibilityLabel)
    }

    private var previewImage: Image {
#if canImport(UIKit)
        if let image = ShannonAppIconAssets.uiImage(for: assetName) {
            return Image(uiImage: image)
        }
        return Image(systemName: "app.dashed")
#elseif canImport(AppKit)
        if let image = ShannonAppIconAssets.nsImage(for: assetName) {
            return Image(nsImage: image)
        }
        return Image(systemName: "app.dashed")
#else
        return Image(systemName: "app.dashed")
#endif
    }
}

private struct ShannonAppearanceSettingsView: View {
    @AppStorage(ShannonAppearanceMode.storageKey) private var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            VStack(spacing: M3Spacing.small) {
                ForEach(ShannonAppearanceMode.allCases) { mode in
                    Button {
                        appearanceModeRawValue = mode.rawValue
                    } label: {
                        HStack(spacing: M3Spacing.medium) {
                            Image(systemName: mode.symbolName)
                                .font(.system(size: 20, weight: .medium))
                                .foregroundStyle(palette.primary)
                                .frame(width: 44, height: 44)
                                .background(palette.secondaryContainer, in: Circle())
                            Text(mode.japaneseName)
                                .font(.body.weight(.medium))
                                .foregroundStyle(palette.onSurface)
                            Spacer()
                            if appearanceModeRawValue == mode.rawValue {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(palette.primary)
                            }
                        }
                        .padding(.horizontal, M3Spacing.large)
                        .frame(minHeight: 64)
                        .background(
                            appearanceModeRawValue == mode.rawValue
                                ? palette.primaryContainer.opacity(0.55)
                                : Color.clear,
                            in: RoundedRectangle(cornerRadius: M3Shape.large)
                        )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(M3Spacing.large)
            .background(palette.surface)
            .navigationTitle("外観")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
        }
    }
}

private enum ShannonWorkspacePage: Int, CaseIterable, Identifiable {
    case talk
    case memory

    var id: Int { rawValue }
    var title: String {
        switch self {
        case .talk: "トーク"
        case .memory: "頭の中"
        }
    }
    var symbol: String {
        switch self {
        case .talk: "bubble.left.and.bubble.right.fill"
        case .memory: "brain.head.profile.fill"
        }
    }
}

private enum ShannonWorkspaceChrome {
    static let contentTopInset: CGFloat = 72
    static let contentBottomInset: CGFloat = 112
}

private struct ShannonAppHeader: View {
    let selection: ShannonWorkspacePage
    let unreadInitiativeCount: Int
    let openThreadDrawer: () -> Void
    let createThread: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: 0) {
            Button(action: openThreadDrawer) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(palette.onSurface)
                        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                    if unreadInitiativeCount > 0 {
                        Text(unreadInitiativeCount > 9 ? "9+" : "\(unreadInitiativeCount)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, unreadInitiativeCount > 9 ? 4 : 3)
                            .frame(minWidth: 15, minHeight: 15)
                            .background(palette.error, in: Capsule())
                            .offset(x: 1, y: 1)
                    }
                }
                .frame(width: 48, height: 48)
                .background(.ultraThinMaterial, in: Circle())
                .overlay {
                    Circle().stroke(palette.outlineVariant.opacity(0.6), lineWidth: 0.7)
                }
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.10), radius: 9, y: 3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("メニュー")

            Spacer(minLength: 0)

            Button(action: createThread) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(palette.onSurface)
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                    .frame(width: 48, height: 48)
                    .background(.ultraThinMaterial, in: Circle())
                    .overlay {
                        Circle().stroke(palette.outlineVariant.opacity(0.6), lineWidth: 0.7)
                    }
                    .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.10), radius: 9, y: 3)
            }
            .buttonStyle(.plain)
            .opacity(selection == .talk ? 1 : 0)
            .allowsHitTesting(selection == .talk)
            .accessibilityHidden(selection != .talk)
            .accessibilityLabel("新しいトーク")
        }
        .padding(.horizontal, M3Spacing.large)
        .frame(maxWidth: .infinity)
    }
}

private struct ShannonTopReadabilityGradient: View {
    let palette: M3Palette

    var body: some View {
        LinearGradient(
            stops: [
                .init(color: palette.surface, location: 0),
                .init(color: palette.surface.opacity(0.90), location: 0.36),
                .init(color: palette.surface.opacity(0.42), location: 0.72),
                .init(color: .clear, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 118)
        .ignoresSafeArea(.container, edges: .top)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct ShannonBottomReadabilityGradient: View {
    let palette: M3Palette

    var body: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: palette.surface.opacity(0.40), location: 0.30),
                .init(color: palette.surface.opacity(0.92), location: 0.72),
                .init(color: palette.surface, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 146)
        .accessibilityHidden(true)
    }
}

private enum ShannonHaptics {
    static func page() {
#if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.65)
#endif
    }

    static func drawer() {
#if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
#endif
    }
}

private struct ShannonThreadDrawer: View {
    let model: ShannonConversationModel
    let selectedThreadId: String?
    let openTalk: () -> Void
    let openMemory: () -> Void
    let openSettings: () -> Void
    let openAgentTask: (UUID) -> Void
    let close: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var creatingTitle = ""
    @State private var isCreating = false
    @State private var creatingError: String?
    @State private var editingThread: ChatThreadDTO?

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        VStack(spacing: 0) {
            HStack {
                Text("Shannon")
                    .font(.title2.bold())
                Spacer()
                Button {
                    Task {
                        isCreating = true
                        defer { isCreating = false }
                        await model.createThread(title: nil)
                        openTalk()
                    }
                } label: {
                    Image(systemName: isCreating ? "ellipsis" : "square.and.pencil")
                        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .disabled(isCreating)
                .accessibilityLabel(isCreating ? "新しいトークを作成中" : "新しいトーク")

                Button(action: close) {
                    Image(systemName: "xmark")
                        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("閉じる")
            }
            .padding(.top, 58)
            .padding(.horizontal, M3Spacing.large)
            .padding(.bottom, M3Spacing.medium)

            ScrollView {
                LazyVStack(spacing: M3Spacing.extraSmall) {
                    ForEach(model.threads, id: \.threadId) { thread in
                        HStack(spacing: 0) {
                            Button {
                                Task {
                                    await model.selectThread(thread.threadId)
                                    openTalk()
                                }
                            } label: {
                                HStack(spacing: M3Spacing.medium) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(thread.title)
                                            .font(.body.weight(thread.threadId == selectedThreadId ? .semibold : .regular))
                                            .foregroundStyle(palette.onSurface)
                                            .lineLimit(2)
                                        HStack(spacing: 6) {
                                            Text(threadUpdatedLabel(thread.updatedAt))
                                            Text("·")
                                            Text("\(thread.messageCount)件")
                                        }
                                        .font(.caption)
                                        .foregroundStyle(palette.onSurfaceVariant)
                                    }
                                    Spacer()
                                    if model.initiativeThreadIDs.contains(thread.threadId) {
                                        Circle()
                                            .fill(palette.primary)
                                            .frame(width: 9, height: 9)
                                            .accessibilityLabel("シャノンからの新しい話")
                                    }
                                    if thread.threadId == selectedThreadId {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(palette.primary)
                                    }
                                }
                                .padding(.leading, M3Spacing.medium)
                                .padding(.vertical, M3Spacing.extraSmall)
                                .frame(minHeight: 58)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(thread.threadId == selectedThreadId ? .isSelected : [])
                            .contextMenu {
                                threadActions(for: thread)
                            }

                            Menu {
                                threadActions(for: thread)
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(palette.onSurfaceVariant)
                                    .frame(width: M3TouchTarget.minimum, height: 58)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityLabel("\(thread.title)の操作")
                        }
                        .background(
                            thread.threadId == selectedThreadId
                                ? palette.secondaryContainer.opacity(0.72)
                                : Color.clear,
                            in: RoundedRectangle(cornerRadius: M3Shape.medium)
                        )
                    }
                }
                .padding(.horizontal, M3Spacing.small)
            }
            .scrollIndicators(.hidden)

            if let creatingError {
                Text(creatingError)
                    .font(.caption)
                    .foregroundStyle(palette.error)
                    .padding(M3Spacing.medium)
            }

            Divider()
                .overlay(palette.outlineVariant.opacity(0.6))

            VStack(spacing: M3Spacing.extraSmall) {
                Button(action: openMemory) {
                    ShannonDrawerDestinationRow(
                        title: "頭の中",
                        detail: "いま・知識・日記",
                        symbol: "brain.head.profile",
                        badge: nil,
                        palette: palette
                    )
                }
                .buttonStyle(.plain)

                if let task = model.agentTaskNotices.first {
                    Button {
                        openAgentTask(task.id)
                    } label: {
                        ShannonDrawerDestinationRow(
                            title: "作業",
                            detail: task.status.japaneseName,
                            symbol: task.status == .waitingApproval ? "hand.raised" : "hammer",
                            badge: model.agentTaskNotices.count,
                            palette: palette
                        )
                    }
                    .buttonStyle(.plain)
                } else {
                    ShannonDrawerDestinationRow(
                        title: "作業",
                        detail: "進行中の作業はありません",
                        symbol: "hammer",
                        badge: nil,
                        palette: palette
                    )
                    .opacity(0.72)
                }

                Button(action: openSettings) {
                    ShannonDrawerDestinationRow(
                        title: "設定",
                        detail: nil,
                        symbol: "gearshape",
                        badge: nil,
                        palette: palette
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, M3Spacing.small)
            .padding(.top, M3Spacing.small)
            .padding(.bottom, 28)
        }
        .frame(maxHeight: .infinity)
        .background(.regularMaterial)
        .overlay(alignment: .trailing) {
            Rectangle().fill(palette.outlineVariant.opacity(0.45)).frame(width: 0.7)
        }
        .shadow(color: .black.opacity(0.16), radius: 20, x: 8)
        .sheet(isPresented: Binding(
            get: { editingThread != nil },
            set: { if !$0 { editingThread = nil } }
        )) {
            if let editingThread {
                ShannonThreadTitleEditor(
                    initialTitle: editingThread.title,
                    save: { title in
                        await model.renameThread(editingThread.threadId, title: title)
                    },
                    cancel: { self.editingThread = nil }
                )
            }
        }
    }

    @ViewBuilder
    private func threadActions(for thread: ChatThreadDTO) -> some View {
        Button {
            editingThread = thread
        } label: {
            Label("タイトルを編集", systemImage: "pencil")
        }

        Button(role: .destructive) {
            Task { await model.archiveThread(thread.threadId) }
        } label: {
            Label("アーカイブ", systemImage: "archivebox")
        }
        .disabled(model.threads.count <= 1)
    }
}

private struct ShannonDrawerDestinationRow: View {
    let title: String
    let detail: String?
    let symbol: String
    let badge: Int?
    let palette: M3Palette

    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(palette.brandPresence)
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(palette.onSurface)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if let badge, badge > 0 {
                Text(badge > 9 ? "9+" : "\(badge)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.onPrimary)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(palette.primary, in: Capsule())
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(.horizontal, M3Spacing.medium)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

private struct ShannonThreadTitleEditor: View {
    let initialTitle: String
    let save: (String) async -> Bool
    let cancel: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var isTitleFieldFocused: Bool
    @State private var title: String
    @State private var isSaving = false

    init(
        initialTitle: String,
        save: @escaping (String) async -> Bool,
        cancel: @escaping () -> Void
    ) {
        self.initialTitle = initialTitle
        self.save = save
        self.cancel = cancel
        _title = State(initialValue: initialTitle)
    }

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        NavigationStack {
            VStack(alignment: .leading, spacing: M3Spacing.medium) {
                Text("トーク一覧に表示する名前を入力してください。")
                    .font(.body)
                    .foregroundStyle(palette.onSurfaceVariant)

                TextField("タイトル", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($isTitleFieldFocused)
                    .padding(M3Spacing.medium)
                    .background(palette.surfaceContainerHigh, in: RoundedRectangle(cornerRadius: M3Shape.medium))
                    .accessibilityLabel("トークのタイトル")

                Text("\(title.count)/80文字")
                    .font(.caption)
                    .foregroundStyle(title.count > 80 ? palette.error : palette.onSurfaceVariant)

                Spacer()
            }
            .padding(M3Spacing.large)
            .navigationTitle("タイトルを編集")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル", action: cancel)
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "保存中…" : "保存") {
                        Task {
                            isSaving = true
                            let didSave = await save(title)
                            isSaving = false
                            if didSave { cancel() }
                        }
                    }
                    .disabled(!isValidTitle || isSaving)
                }
            }
        }
        .presentationDetents([.medium])
        .task { isTitleFieldFocused = true }
    }

    private var isValidTitle: Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= 80
    }
}


private struct ShannonSettingsRow: View {
    let title: String
    let detail: String
    let symbol: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.primary)
                .frame(width: 44, height: 44)
                .background(palette.secondaryContainer, in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
            }

            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.7), lineWidth: 0.7)
        }
    }
}

private extension View {
    @ViewBuilder
    func shannonKeyboardDismissMode() -> some View {
#if os(iOS)
        scrollDismissesKeyboard(.interactively)
#else
        self
#endif
    }
}

private struct ShannonEmptyConversation: View {
    var body: some View {
        ShannonAvatarView(expression: .curious, size: 96)
            .frame(maxWidth: .infinity)
            .padding(M3Spacing.extraLarge)
            .accessibilityLabel("シャノン")
    }
}

private struct ShannonConversationDayDivider: View {
    let day: Date
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        HStack(spacing: M3Spacing.medium) {
            Rectangle().fill(palette.outlineVariant.opacity(0.52)).frame(height: 0.5)
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(palette.onSurfaceVariant)
                .fixedSize()
            Rectangle().fill(palette.outlineVariant.opacity(0.52)).frame(height: 0.5)
        }
        .padding(.vertical, M3Spacing.small)
        .accessibilityLabel(label)
    }

    private var label: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "今日" }
        if calendar.isDateInYesterday(day) { return "昨日" }
        return day.formatted(.dateTime.year().month(.abbreviated).day().weekday(.abbreviated))
    }
}

private struct ShannonContextReferenceCard: View {
    let memory: ActiveMemoryDTO
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        HStack(alignment: .top, spacing: M3Spacing.small) {
            Image(systemName: "arrow.uturn.backward.circle.fill")
                .foregroundStyle(palette.brandPresence)
            VStack(alignment: .leading, spacing: 3) {
                Text("思い出したこと")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.brandPresence)
                Text(memory.summary)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.vertical, M3Spacing.small)
        .background(palette.primaryContainer.opacity(0.42), in: RoundedRectangle(cornerRadius: M3Shape.medium))
        .padding(.leading, 62)
        .accessibilityElement(children: .combine)
    }
}

private struct ShannonMessageRow: View {
    let message: ConversationMessage
    let isSendingToAether: Bool
    let wasSentToAether: Bool
    let sendToAether: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var didCopy = false

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        Group {
            if message.role == .shannon {
                shannonReply(palette)
            } else {
                userMessage(palette)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .sensoryFeedback(.success, trigger: didCopy)
        .contextMenu {
            Button(action: copyMessage) {
                Label("コピー", systemImage: "doc.on.doc")
            }
            if message.role == .shannon {
                Button(action: sendToAether) {
                    Label(
                        wasSentToAether ? "Aetherへ送信済み" : isSendingToAether ? "送信中…" : "Aetherへ提案として送る",
                        systemImage: wasSentToAether ? "checkmark.circle" : "square.and.arrow.up"
                    )
                }
                .disabled(isSendingToAether || wasSentToAether)
            }
        }
    }

    private func shannonReply(_ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.extraSmall) {
            HStack(alignment: .center, spacing: M3Spacing.extraSmall) {
                ShannonAvatarView(
                    expression: message.emotionSnapshot?.expression ?? .neutral,
                    size: 42
                )

                Text("シャノン")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(palette.onSurface)

                if let expression = message.emotionSnapshot?.expression {
                    Text("· \(expression.japaneseName)")
                }
                Text("· \(message.sentAt.formatted(date: .omitted, time: .shortened))")
                    .lineLimit(1)

                Spacer(minLength: 0)

                Button(action: copyMessage) {
                    Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.semibold))
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.onSurfaceVariant)
                .accessibilityLabel(didCopy ? "コピーしました" : "シャノンの回答をコピー")
            }
            .font(.caption2)
            .foregroundStyle(palette.onSurfaceVariant)

            messageText
                .font(.body)
                .lineSpacing(2)
                .textSelection(.enabled)
                .foregroundStyle(palette.onSurface)
                .tint(palette.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func userMessage(_ palette: M3Palette) -> some View {
        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            Spacer(minLength: 64)

            VStack(alignment: .trailing, spacing: 5) {
                messageText
                    .font(.body)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .foregroundStyle(palette.onPrimaryContainer)
                    .tint(palette.primary)
                    .padding(.horizontal, M3Spacing.large)
                    .padding(.vertical, M3Spacing.small + 2)
                    .background(
                        palette.primaryContainer,
                        in: RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
                    )

                HStack(spacing: 5) {
                    Text(message.sentAt.formatted(date: .omitted, time: .shortened))
                    deliveryIcon(palette)
                }
                .font(.caption2)
                .foregroundStyle(message.deliveryState == .failed ? palette.error : palette.onSurfaceVariant)
                .padding(.horizontal, M3Spacing.extraSmall)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func copyMessage() {
#if canImport(UIKit)
        UIPasteboard.general.string = message.text
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.text, forType: .string)
#endif
        didCopy = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            didCopy = false
        }
    }

    @ViewBuilder
    private var messageText: some View {
        Text(ShannonMessageMarkdown.render(message.text))
    }

    @ViewBuilder
    private func deliveryIcon(_ palette: M3Palette) -> some View {
        switch message.deliveryState {
        case .sending:
            Image(systemName: "clock")
        case .sent:
            Image(systemName: "checkmark")
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(palette.error)
        }
    }

    private var accessibilityLabel: String {
        let speaker = message.role == .shannon ? "シャノン" : "あなた"
        let emotion = message.emotionSnapshot.map { "。\($0.expression.japaneseName)表情" } ?? ""
        let delivery = message.deliveryState == .failed ? "。送信失敗" : ""
        return "\(speaker)。\(message.text)\(emotion)\(delivery)"
    }
}

private struct ShannonTypingIndicator: View {
    let expression: ShannonExpressionDTO

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            ShannonAvatarView(expression: expression, size: 54)
            HStack(spacing: M3Spacing.small) {
                ProgressView()
                    .controlSize(.small)
                    .tint(palette.primary)
                Text("考えている…")
                    .font(.callout)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            .padding(.horizontal, M3Spacing.large)
            .frame(minHeight: M3TouchTarget.minimum)
            .background(palette.surfaceContainerHigh, in: Capsule())
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("シャノンが考えています")
    }
}

private struct ShannonDialogueBubble<Content: View>: View {
    let palette: M3Palette
    let isExpanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, M3Spacing.large)
            .padding(.vertical, M3Spacing.medium)
            .frame(maxWidth: 350, minHeight: 54, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(palette.outlineVariant.opacity(0.62), lineWidth: 0.7)
            }
            .overlay(alignment: .bottom) {
                ShannonSpeechTail()
                    .fill(palette.surface.opacity(0.94))
                    .frame(width: 24, height: 16)
                    .offset(x: 74, y: 14)
            }
            .shadow(color: .black.opacity(0.11), radius: isExpanded ? 18 : 12, y: 5)
            .padding(.horizontal, M3Spacing.large)
            .accessibilityElement(children: .contain)
    }
}

private struct ShannonSpeechTail: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addQuadCurve(
            to: CGPoint(x: rect.width, y: 0),
            control: CGPoint(x: rect.width * 0.58, y: rect.height * 0.18)
        )
        path.addLine(to: CGPoint(x: rect.width * 0.70, y: rect.height))
        path.closeSubpath()
        return path
    }
}

private struct ShannonThinkingDots: View {
    @State private var activeDot = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 7) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .frame(width: 7, height: 7)
                    .scaleEffect(!reduceMotion && activeDot == index ? 1.35 : 0.82)
                    .opacity(reduceMotion || activeDot == index ? 1 : 0.42)
            }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, minHeight: 24, alignment: .center)
        .accessibilityLabel("シャノンが考えています")
        .task {
            guard !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(380))
                withAnimation(.easeInOut(duration: 0.22)) {
                    activeDot = (activeDot + 1) % 3
                }
            }
        }
    }
}

private func threadUpdatedLabel(_ value: String) -> String {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    let date = (try? fractional.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    guard let date else { return "更新日時不明" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) {
        return date.formatted(date: .omitted, time: .shortened)
    }
    if calendar.isDateInYesterday(date) { return "昨日" }
    return date.formatted(.dateTime.month(.abbreviated).day())
}

private struct ShannonSnackbar: View {
    let message: String
    let showsRetry: Bool
    let retry: () -> Void
    let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.small) {
            Image(systemName: "wifi.exclamationmark")
            Text(message)
                .font(.callout)
                .lineLimit(2)
            Spacer(minLength: M3Spacing.small)
            if showsRetry {
                Button("再送", action: retry)
                    .font(.labelStyle)
                    .foregroundStyle(palette.primaryContainer)
                    .frame(minHeight: M3TouchTarget.minimum)
            }
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            }
            .accessibilityLabel("閉じる")
        }
        .foregroundStyle(palette.surface)
        .padding(.leading, M3Spacing.large)
        .padding(.trailing, M3Spacing.extraSmall)
        .background(palette.onSurface, in: RoundedRectangle(cornerRadius: M3Shape.small, style: .continuous))
        .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
    }
}

private struct ShannonVoiceStatusBar: View {
    let model: ShannonVoiceConversationModel
    let primaryAction: () -> Void
    let cancel: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        HStack(spacing: M3Spacing.small) {
            Image(systemName: model.phase.symbolName)
                .symbolEffect(.variableColor.iterative, isActive: model.phase == .listening || model.phase == .speaking)
                .foregroundStyle(palette.primary)
                .frame(width: 30)

            VStack(alignment: .leading, spacing: 2) {
                Text(model.phase.japaneseLabel)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                if model.phase == .listening {
                    Text(String(format: "%.1f 秒 · 最大60秒", model.recordingDuration))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.onSurfaceVariant)
                } else if !model.transcript.isEmpty {
                    Text(model.transcript)
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                        .lineLimit(2)
                } else if let errorMessage = model.errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(palette.error)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if model.primaryAction != .none {
                Button(action: primaryAction) {
                    Image(systemName: model.primaryAction == .send ? "arrow.up" : model.phase.symbolName)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(palette.onPrimary)
                        .frame(width: 36, height: 36)
                        .background(palette.primary, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.phase.japaneseLabel)
            }

            Button(action: cancel) {
                Image(systemName: "xmark")
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.onSurfaceVariant)
            .accessibilityLabel("音声会話を閉じる")
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.vertical, M3Spacing.small)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ShannonStateSheet: View {
    let state: CompanionStateDTO?
    let expression: ShannonExpressionDTO

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                    HStack(spacing: M3Spacing.large) {
                        ShannonAvatarView(expression: expression, size: 72)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(expression.japaneseName)
                                .font(.title2.weight(.semibold))
                            Text("シャノンのいま")
                                .font(.body)
                                .foregroundStyle(palette.onSurfaceVariant)
                        }
                    }

                    if let state {
                        VStack(spacing: M3Spacing.medium) {
                            StateMeter(label: "好奇心", value: state.temperament.curiosity, palette: palette)
                            StateMeter(label: "親密さ", value: state.temperament.closeness, palette: palette)
                            StateMeter(label: "活性", value: state.emotion.arousal, palette: palette)
                            StateMeter(label: "心の開き", value: state.emotion.openness, palette: palette)
                        }
                        .padding(M3Spacing.large)
                        .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))

                        if !state.interests.isEmpty {
                            VStack(alignment: .leading, spacing: M3Spacing.medium) {
                                Text("いま興味があること")
                                    .font(.title3.weight(.semibold))
                                FlowLikeChips(values: state.interests, palette: palette)
                            }
                        }
                    } else {
                        Text("最初の会話のあとに、シャノンの状態がここに現れます。")
                            .font(.body)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(M3Spacing.large)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                    }
                }
                .padding(M3Spacing.extraLarge)
            }
            .background(palette.surface)
            .navigationTitle("シャノンの状態")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct StateMeter: View {
    let label: String
    let value: Double
    let palette: M3Palette

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(label).font(.callout.weight(.medium))
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            ProgressView(value: value)
                .tint(palette.primary)
        }
    }
}

private struct FlowLikeChips: View {
    let values: [String]
    let palette: M3Palette

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: M3Spacing.small) {
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(.labelStyle)
                        .foregroundStyle(palette.onSecondaryContainer)
                        .padding(.horizontal, M3Spacing.medium)
                        .frame(minHeight: 40)
                        .background(palette.secondaryContainer, in: Capsule())
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

private extension Font {
    static var labelStyle: Font { .callout.weight(.semibold) }
}
