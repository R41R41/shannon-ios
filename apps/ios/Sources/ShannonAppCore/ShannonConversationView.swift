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
    @State private var appIconModel = ShannonAppIconModel()
    @State private var showsStateDetails = false
    @State private var showsConnectionDetails = false
    @State private var showsAppIconSettings = false
    @State private var showsAppearanceSettings = false
    @State private var selectedPage: ShannonWorkspacePage = .talk
    @State private var workspaceProgress: CGFloat = 0
    @State private var drawerProgress: CGFloat = 0
    @State private var dragIntent: ShannonHorizontalDragIntent?
    @State private var dragStartProgress: CGFloat = 0
    @State private var displayMode: ShannonConversationDisplayMode = Self.savedDisplayMode
    @State private var dialogueIsExpanded = false
    @State private var selectedAgentTaskID: UUID?
    @AppStorage(ShannonAppearanceMode.storageKey) private var appearanceModeRawValue = ShannonAppearanceMode.system.rawValue
    @FocusState private var composerIsFocused: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    public init(
        model: ShannonConversationModel = ShannonConversationModel(),
        connectionModel: ShannonConnectionModel? = nil,
        memoryModel: ShannonMemoryModel = ShannonMemoryModel()
    ) {
        _model = State(initialValue: model)
        _connectionModel = State(initialValue: connectionModel)
        _memoryModel = State(initialValue: memoryModel)
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        GeometryReader { geometry in
            ZStack(alignment: .top) {
                workspacePages(palette, width: geometry.size.width)

            ShannonWorkspaceSwitcher(
                selection: selectedPage,
                pageProgress: workspaceProgress,
                unreadInitiativeCount: model.unreadInitiativeCount,
                agentTasks: model.agentTaskNotices,
                openAgentTask: openAgentTask,
                select: selectWorkspacePage
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
                        close: closeThreadDrawer
                    )
                    .frame(width: drawerWidth(for: geometry.size.width))
                    Spacer(minLength: 0)
                }
                .offset(x: -drawerWidth(for: geometry.size.width) * (1 - drawerProgress))
                .ignoresSafeArea()
                .allowsHitTesting(drawerProgress > 0.98)
                .accessibilityHidden(drawerProgress < 0.98)
            }
            .clipped()
            .simultaneousGesture(horizontalWorkspaceGesture(viewWidth: geometry.size.width))
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
            guard selectedPage == .memory else { return }
            Task { await memoryModel.reload() }
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
#if os(iOS)
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

    @ViewBuilder
    private func workspacePages(_ palette: M3Palette, width: CGFloat) -> some View {
        HStack(spacing: 0) {
            talkPage(palette)
                .frame(width: width)
                .accessibilityHidden(selectedPage != .talk)
            ShannonMemoryView(
                model: memoryModel,
                showsDismissButton: false,
                workspaceTopInset: ShannonWorkspaceChrome.contentTopInset
            )
            .frame(width: width)
            .accessibilityHidden(selectedPage != .memory)
            settingsPage(palette)
                .frame(width: width)
                .accessibilityHidden(selectedPage != .settings)
        }
        .frame(width: width * 3, alignment: .leading)
        .offset(x: -workspaceProgress * width)
        .frame(width: width, alignment: .leading)
    }

    private func talkPage(_ palette: M3Palette) -> some View {
        ZStack(alignment: .bottom) {
            Group {
                switch displayMode {
                case .scroll:
                    messageList(palette)
                case .dialogue:
                    dialogueStage(palette)
                }
            }

            VStack(spacing: M3Spacing.small) {
                Spacer()
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

            VStack {
                HStack {
                    Spacer()
                    Button(action: toggleDisplayMode) {
                        Label(displayMode.japaneseName, systemImage: displayMode.symbolName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(.horizontal, M3Spacing.medium)
                            .frame(minHeight: 38)
                            .background(.thinMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("表示を\(displayMode == .scroll ? "対話" : "スクロール")モードへ切り替える")
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.top, ShannonWorkspaceChrome.contentTopInset)
                Spacer()
            }
        }
        .background(palette.surface)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
    }

    private func messageList(_ palette: M3Palette) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: M3Spacing.large) {
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
                .padding(.bottom, 124)
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

            Button(action: sendDraft) {
                ZStack {
                    Circle()
                        .fill(model.canSendDraft ? palette.primary : palette.surface)
                    if model.isSending {
                        ProgressView()
                            .tint(palette.onSurfaceVariant)
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(model.canSendDraft ? palette.onPrimary : palette.onSurfaceVariant)
                    }
                }
                .frame(width: 40, height: 40)
            }
            .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            .buttonStyle(.plain)
            .disabled(!model.canSendDraft)
            .accessibilityLabel(model.isSending ? "送信中" : "送信")
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

    private func settingsPage(_ palette: M3Palette) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: M3Spacing.large) {
                Text("設定")
                    .font(.largeTitle.bold())
                    .padding(.horizontal, M3Spacing.extraSmall)

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
            .padding(.top, ShannonWorkspaceChrome.contentTopInset)
            .padding(.bottom, M3Spacing.huge)
        }
        .scrollIndicators(.hidden)
        .background(Color.clear)
    }

    private func horizontalWorkspaceGesture(viewWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .local)
            .onChanged { value in
                guard !composerIsFocused else { return }
                guard abs(value.translation.width) > abs(value.translation.height) * 1.15 else { return }
                if dragIntent == nil {
                    dragStartProgress = drawerProgress > 0 ? drawerProgress : workspaceProgress
                    if drawerProgress > 0
                        || (selectedPage == .talk
                            && workspaceProgress < 0.01
                            && value.startLocation.x <= viewWidth / 2
                            && value.translation.width > 0) {
                        dragIntent = .threadDrawer
                        composerIsFocused = false
                    } else {
                        dragIntent = .workspace
                    }
                }

                switch dragIntent {
                case .threadDrawer:
                    drawerProgress = ShannonWorkspaceMotionPolicy.drawerProgress(
                        from: dragStartProgress,
                        translation: value.translation.width,
                        drawerWidth: drawerWidth(for: viewWidth)
                    )
                case .workspace:
                    workspaceProgress = ShannonWorkspaceMotionPolicy.pageProgress(
                        from: dragStartProgress,
                        translation: value.translation.width,
                        width: viewWidth,
                        pageCount: ShannonWorkspacePage.allCases.count
                    )
                case nil:
                    break
                }
            }
            .onEnded { value in
                defer { dragIntent = nil }
                switch dragIntent {
                case .threadDrawer:
                    settleDrawer(open: ShannonWorkspaceMotionPolicy.shouldOpenDrawer(
                        from: dragStartProgress,
                        predictedTranslation: value.predictedEndTranslation.width,
                        drawerWidth: drawerWidth(for: viewWidth)
                    ))
                case .workspace:
                    let targetIndex = ShannonWorkspaceMotionPolicy.targetPage(
                        from: dragStartProgress,
                        predictedTranslation: value.predictedEndTranslation.width,
                        width: viewWidth,
                        pageCount: ShannonWorkspacePage.allCases.count
                    )
                    guard let target = ShannonWorkspacePage(rawValue: targetIndex) else { return }
                    settleWorkspace(on: target)
                case nil:
                    break
                }
            }
    }

    private func selectWorkspacePage(_ page: ShannonWorkspacePage) {
        guard !composerIsFocused else {
            composerIsFocused = false
            return
        }
        settleWorkspace(on: page)
        guard page == .talk else { return }
        Task { await model.acknowledgeVisibleInitiatives() }
    }

    private func settleWorkspace(on page: ShannonWorkspacePage) {
        let changed = page != selectedPage
        selectedPage = page
        composerIsFocused = false
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.34, extraBounce: 0.04)) {
            workspaceProgress = CGFloat(page.rawValue)
        }
        if changed { ShannonHaptics.page() }
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
            let keyboardScale: CGFloat = composerIsFocused ? 0.78 : 1
            let portraitWidth = min(geometry.size.width * 0.92, 390) * keyboardScale

            ZStack(alignment: .top) {
                LinearGradient(
                    colors: [palette.surface, palette.primaryContainer.opacity(0.34), palette.surface],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()

                ShannonDialogueStagePortraitView()
                    .frame(width: portraitWidth)
                    .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
                    .overlay(alignment: .bottomTrailing) {
                        ShannonAvatarView(expression: model.currentExpression, size: 58)
                            .padding(M3Spacing.medium)
                            .accessibilityLabel("いまの表情：\(model.currentExpression.japaneseName)")
                    }
                    .shadow(color: palette.primary.opacity(0.10), radius: 24, y: 12)
                .position(
                    x: geometry.size.width / 2,
                    y: geometry.size.height * (composerIsFocused ? 0.55 : 0.60)
                )
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.24), value: composerIsFocused)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.20), value: model.currentExpression)

                if model.isSending {
                    ShannonDialogueBubble(palette: palette, isExpanded: false) {
                        ShannonThinkingDots()
                    }
                    .padding(.top, ShannonWorkspaceChrome.contentTopInset + 54)
                    .transition(.opacity)
                } else if let reply = model.messages.last(where: { $0.role == .shannon }) {
                    ShannonDialogueBubble(palette: palette, isExpanded: dialogueIsExpanded) {
                        ScrollView(dialogueIsExpanded ? .vertical : []) {
                            Text(reply.text)
                                .font(.body)
                                .lineSpacing(3)
                                .foregroundStyle(palette.onSurface)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .scrollIndicators(.hidden)
                        .frame(maxHeight: dialogueIsExpanded ? min(300, geometry.size.height * 0.42) : 150)
                    }
                    .padding(.top, ShannonWorkspaceChrome.contentTopInset + 54)
                    .onTapGesture {
                        guard reply.text.count > 120 else { return }
                        withAnimation(reduceMotion ? nil : .snappy(duration: 0.24)) {
                            dialogueIsExpanded.toggle()
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { composerIsFocused = false }
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
        guard model.canSendDraft else { return }
        Task { await model.sendDraft() }
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
                    Picker(
                        "変更方法",
                        selection: Binding(
                            get: { model.mode },
                            set: { newMode in
                                Task {
                                    await model.selectMode(newMode, expression: expression)
                                }
                            }
                        )
                    ) {
                        ForEach(ShannonAppIconMode.allCases) { mode in
                            Text(mode.japaneseName).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    if model.mode == .manual {
                        LazyVGrid(
                            columns: [
                                GridItem(.flexible(), spacing: M3Spacing.small),
                                GridItem(.flexible(), spacing: M3Spacing.small),
                            ],
                            spacing: M3Spacing.small
                        ) {
                            ForEach(ShannonAppIconChoice.allCases) { choice in
                                Button {
                                    Task { await model.selectManualChoice(choice) }
                                } label: {
                                    VStack(spacing: M3Spacing.small) {
                                        Image(systemName: choice.symbolName)
                                            .font(.system(size: 24, weight: .semibold))
                                        Text(choice.japaneseName)
                                            .font(.callout.weight(.semibold))
                                    }
                                    .foregroundStyle(
                                        model.manualChoice == choice
                                            ? palette.onPrimaryContainer
                                            : palette.onSurface
                                    )
                                    .frame(maxWidth: .infinity, minHeight: 88)
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
                            }
                        }
                    }

                    HStack {
                        Text("現在")
                            .foregroundStyle(palette.onSurfaceVariant)
                        Spacer()
                        Text(model.activeTitle)
                            .fontWeight(.semibold)
                    }
                    .padding(M3Spacing.large)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))

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
    case settings

    var id: Int { rawValue }
    var title: String {
        switch self {
        case .talk: "トーク"
        case .memory: "メモリー"
        case .settings: "設定"
        }
    }
    var symbol: String {
        switch self {
        case .talk: "bubble.left.and.bubble.right.fill"
        case .memory: "brain.head.profile.fill"
        case .settings: "gearshape.fill"
        }
    }
}

private enum ShannonWorkspaceChrome {
    static let contentTopInset: CGFloat = 72
}

private struct ShannonWorkspaceSwitcher: View {
    let selection: ShannonWorkspacePage
    let pageProgress: CGFloat
    let unreadInitiativeCount: Int
    let agentTasks: [ShannonAgentTask]
    let openAgentTask: (UUID) -> Void
    let select: (ShannonWorkspacePage) -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.small) {
            ShannonWorkspaceTrack(
                progress: min(max(pageProgress, 0), 1),
                palette: palette,
                unreadInitiativeCount: unreadInitiativeCount,
                select: select
            )
            .frame(maxWidth: .infinity)

            if !agentTasks.isEmpty {
                Menu {
                    ForEach(agentTasks) { task in
                        Button {
                            openAgentTask(task.id)
                        } label: {
                            Label("\(task.title) · \(task.status.japaneseName)", systemImage: task.status.symbolName)
                        }
                    }
                } label: {
                    ZStack(alignment: .topTrailing) {
                        Image(systemName: agentTasks.contains(where: { $0.status == .waitingApproval })
                            ? "hand.raised.fill" : "hammer.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(agentTasks.contains(where: { $0.status == .waitingApproval })
                                ? Color(hex: 0xA76012) : palette.primary)
                            .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                            .background(.thinMaterial, in: Circle())

                        Text(agentTasks.count > 9 ? "9+" : "\(agentTasks.count)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, agentTasks.count > 9 ? 4 : 3)
                            .frame(minWidth: 15, minHeight: 15)
                            .background(palette.error, in: Capsule())
                            .offset(x: 2, y: 1)
                    }
                }
                .accessibilityLabel("作業一覧、\(agentTasks.count)件")
                .accessibilityHint(agentTasks.contains(where: { $0.status == .waitingApproval })
                    ? "許可が必要な作業があります" : "実行中または未確認の作業を開きます")
            }

            Button {
                select(.settings)
            } label: {
                Image(systemName: ShannonWorkspacePage.settings.symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(selection == .settings ? palette.onPrimary : palette.onSurfaceVariant)
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                    .background(
                        palette.primary.opacity(min(max(pageProgress - 1, 0), 1)),
                        in: Circle()
                    )
            }
            .buttonStyle(.plain)
            .background(Color.clear)
            .accessibilityLabel("設定")
            .accessibilityAddTraits(selection == .settings ? .isSelected : [])
        }
        .padding(.horizontal, M3Spacing.large)
        .frame(maxWidth: .infinity)
    }
}

private struct ShannonWorkspaceTrack: View {
    let progress: CGFloat
    let palette: M3Palette
    let unreadInitiativeCount: Int
    let select: (ShannonWorkspacePage) -> Void

    var body: some View {
        GeometryReader { geometry in
            let inset = M3Spacing.extraSmall
            let itemWidth = (geometry.size.width - inset * 2) / 2
            let indicatorX = inset + itemWidth * progress

            ZStack(alignment: .leading) {
                Capsule()
                    .fill(palette.surface.opacity(0.72))
                    .overlay {
                        Capsule().stroke(palette.outlineVariant.opacity(0.48), lineWidth: 0.7)
                    }

                Capsule()
                    .fill(palette.primary)
                    .frame(width: itemWidth, height: 40)
                    .offset(x: indicatorX)

                workspaceLabels(
                    color: palette.onSurfaceVariant,
                    unreadInitiativeCount: unreadInitiativeCount,
                    unreadBadgeColor: palette.error
                )
                    .accessibilityHidden(true)

                workspaceLabels(
                    color: palette.onPrimary,
                    unreadInitiativeCount: unreadInitiativeCount,
                    unreadBadgeColor: palette.error
                )
                    .mask(alignment: .leading) {
                        Capsule()
                            .frame(width: itemWidth, height: 40)
                            .offset(x: indicatorX)
                    }
                    .accessibilityHidden(true)

                HStack(spacing: 0) {
                    ForEach([ShannonWorkspacePage.talk, .memory]) { page in
                        Button { select(page) } label: {
                            Color.clear
                        }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .contentShape(Rectangle())
                            .accessibilityLabel(page.title)
                        }
                }
                .padding(.horizontal, inset)
            }
        }
        .frame(height: M3TouchTarget.minimum)
    }

    private func workspaceLabels(
        color: Color,
        unreadInitiativeCount: Int,
        unreadBadgeColor: Color
    ) -> some View {
        HStack(spacing: 0) {
            ForEach([ShannonWorkspacePage.talk, .memory]) { page in
                HStack(spacing: 6) {
                    Label(page.title, systemImage: page.symbol)
                    if page == .talk && unreadInitiativeCount > 0 {
                        Text(unreadInitiativeCount > 9 ? "9+" : "\(unreadInitiativeCount)")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, unreadInitiativeCount > 9 ? 5 : 4)
                            .frame(minHeight: 14)
                            .background(unreadBadgeColor, in: Capsule())
                            .padding(.leading, -2)
                    }
                }
                .font(.callout.weight(.semibold))
                .foregroundStyle(color)
                .frame(maxWidth: .infinity, minHeight: 40)
            }
        }
        .padding(.horizontal, M3Spacing.extraSmall)
    }
}

private enum ShannonHorizontalDragIntent {
    case workspace
    case threadDrawer
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
                Text("トーク")
                    .font(.title2.bold())
                Spacer()
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

            Button {
                Task {
                    isCreating = true
                    defer { isCreating = false }
                    await model.createThread(title: nil)
                    close()
                }
            } label: {
                Label(isCreating ? "作成中…" : "新しいトーク", systemImage: "square.and.pencil")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(palette.primaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.large))
            }
            .buttonStyle(.plain)
            .disabled(isCreating)
            .padding(.horizontal, M3Spacing.large)
            .padding(.bottom, M3Spacing.medium)

            ScrollView {
                LazyVStack(spacing: M3Spacing.extraSmall) {
                    ForEach(model.threads, id: \.threadId) { thread in
                        Button {
                            Task {
                                await model.selectThread(thread.threadId)
                                close()
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
                            .padding(.horizontal, M3Spacing.medium)
                            .frame(minHeight: 58)
                            .background(
                                thread.threadId == selectedThreadId
                                    ? palette.secondaryContainer.opacity(0.72)
                                    : Color.clear,
                                in: RoundedRectangle(cornerRadius: M3Shape.medium)
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
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
        }
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
                .foregroundStyle(palette.primary)
            VStack(alignment: .leading, spacing: 3) {
                Text("思い出したこと")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.primary)
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
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            ShannonAvatarView(
                expression: message.emotionSnapshot?.expression ?? .neutral,
                size: 48
            )

            VStack(alignment: .leading, spacing: M3Spacing.small) {
                messageText
                    .font(.body)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .foregroundStyle(palette.onSurface)
                    .tint(palette.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: M3Spacing.small) {
                    if let expression = message.emotionSnapshot?.expression {
                        Text(expression.japaneseName)
                    }
                    Text(message.sentAt.formatted(date: .omitted, time: .shortened))
                    Spacer(minLength: 0)
                    Button(action: copyMessage) {
                        Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                            .font(.caption.weight(.semibold))
                            .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(didCopy ? "コピーしました" : "シャノンの回答をコピー")
                }
                .font(.caption2)
                .foregroundStyle(palette.onSurfaceVariant)
            }
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
                    .foregroundStyle(palette.onPrimary)
                    .tint(palette.primaryContainer)
                    .padding(.horizontal, M3Spacing.large)
                    .padding(.vertical, M3Spacing.medium)
                    .background(
                        palette.primary,
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
