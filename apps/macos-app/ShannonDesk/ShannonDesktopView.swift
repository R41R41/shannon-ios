import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

public struct ShannonDesktopRootView: View {
    @Bindable private var conversation: ShannonConversationModel
    private let connection: ShannonConnectionModel
    private let memory: ShannonMemoryModel

    @SceneStorage("shannon.desktop.destination") private var destinationRawValue = DesktopDestination.talk.rawValue
    @SceneStorage("shannon.desktop.selectedThread") private var restoredThreadID: String?
    @SceneStorage("shannon.desktop.showsInspector") private var showsInspector = false
    @State private var searchText = ""
    @State private var selectedTaskID: UUID?
    @State private var showsConnection = false
    @State private var renameThread: ChatThreadDTO?
    @State private var renameText = ""
    @FocusState private var focusedControl: ShannonDesktopFocusedControl?
    @AppStorage(ShannonAppearanceMode.storageKey) private var appearanceRawValue = ShannonAppearanceMode.system.rawValue

    public init(
        conversation: ShannonConversationModel,
        connection: ShannonConnectionModel,
        memory: ShannonMemoryModel
    ) {
        self.conversation = conversation
        self.connection = connection
        self.memory = memory
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
        .alert("トークタイトルを変更", isPresented: renameAlertBinding) {
            TextField("タイトル", text: $renameText)
            Button("キャンセル", role: .cancel) { renameThread = nil }
            Button("保存") { saveThreadRename() }
                .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .task {
            if connection.isConnected && !conversation.isDesignPreview {
                await connection.verifyConnection()
            }
            await conversation.loadConversationIfNeeded()
            await restoreSelectedThreadIfAvailable()
            if !conversation.isDesignPreview {
                await conversation.synchronizeAgentTasks()
                await conversation.refreshInitiatives()
            }
        }
        .onChange(of: conversation.latestActiveAgentTask?.id) {
            if selectedTaskID == nil {
                selectedTaskID = conversation.latestActiveAgentTask?.id
            }
        }
        .onChange(of: conversation.selectedThreadId) {
            restoredThreadID = conversation.selectedThreadId
        }
        .focusedSceneValue(\.shannonDesktopCommandActions, desktopCommandActions)
        .toolbarBackground(Color(nsColor: .textBackgroundColor), for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .frame(minWidth: 860, minHeight: 600)
    }

    private var filteredThreads: [ChatThreadDTO] {
        ShannonDesktopThreadSearch.matches(conversation.threads, query: searchText)
    }

    private var destination: DesktopDestination {
        DesktopDestination(rawValue: destinationRawValue) ?? .talk
    }

    private var desktopCommandActions: ShannonDesktopCommandActions {
        ShannonDesktopCommandActions(
            focusThreadSearch: focusThreadSearch,
            showTalk: { selectDestination(.talk) },
            showWork: { selectDestination(.work) },
            showMemory: { selectDestination(.memory) },
            showSettings: { selectDestination(.settings) },
            toggleInspector: {
                selectedTaskID = selectedTaskID
                    ?? conversation.latestActiveAgentTask?.id
                    ?? conversation.agentTasks.first?.id
                showsInspector.toggle()
            }
        )
    }

    private var selectedTask: ShannonAgentTask? {
        if let selectedTaskID,
           let task = conversation.agentTasks.first(where: { $0.id == selectedTaskID }) {
            return task
        }
        return conversation.latestActiveAgentTask ?? conversation.agentTasks.first
    }

    private var workProjection: ShannonDesktopWorkProjection {
        ShannonDesktopWorkProjection(tasks: conversation.agentTasks)
    }

    private var renameAlertBinding: Binding<Bool> {
        Binding(
            get: { renameThread != nil },
            set: { if !$0 { renameThread = nil } }
        )
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ShannonAvatarView(expression: conversation.currentExpression, size: 28)
                Text("Shannon")
                    .font(.headline)
                Spacer()
                Button {
                    Task {
                        await conversation.createThread(title: nil)
                        selectDestination(.talk)
                    }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .buttonStyle(.borderless)
                .help("新しいトーク")
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("トークを検索", text: $searchText)
                    .textFieldStyle(.plain)
                    .focused($focusedControl, equals: .threadSearch)
                    .onSubmit { openFirstSearchResult() }
                    .onExitCommand {
                        if searchText.isEmpty {
                            focusedControl = nil
                        } else {
                            searchText = ""
                        }
                    }
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        focusedControl = .threadSearch
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("検索を消去")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .overlay(alignment: .bottom) { Divider() }
            .padding(.bottom, 8)

            List {
                Section {
                    DesktopSidebarButton(
                        title: "会話",
                        symbol: "bubble.left.and.bubble.right",
                        badge: conversation.unreadInitiativeCount,
                        selected: destination == .talk
                    ) { selectDestination(.talk) }
                    DesktopSidebarButton(
                        title: "作業全体",
                        symbol: "point.3.connected.trianglepath.dotted",
                        badge: conversation.unreadAgentTaskCount,
                        selected: destination == .work
                    ) { selectDestination(.work) }
                    DesktopSidebarButton(
                        title: "頭の中",
                        symbol: "brain.head.profile",
                        badge: 0,
                        selected: destination == .memory
                    ) { selectDestination(.memory) }
                }

                Section("トーク") {
                    ForEach(filteredThreads, id: \.threadId) { thread in
                        Button {
                            Task {
                                await conversation.selectThread(thread.threadId)
                                selectDestination(.talk)
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Text(thread.title)
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                if thread.threadId == conversation.selectedThreadId {
                                    Circle()
                                        .fill(Color.accentColor)
                                        .frame(width: 5, height: 5)
                                        .accessibilityHidden(true)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("タイトルを変更") {
                                renameThread = thread
                                renameText = thread.title
                            }
                            Button("アーカイブ", role: .destructive) {
                                Task { await conversation.archiveThread(thread.threadId) }
                            }
                            .disabled(conversation.threads.count <= 1)
                        }
                    }
                    if filteredThreads.isEmpty {
                        Text("一致するトークはありません")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                    }
                }
            }
            .listStyle(.sidebar)

            Divider()
            VStack(spacing: 2) {
                DesktopSidebarButton(
                    title: "設定",
                    symbol: "gearshape",
                    badge: 0,
                    selected: destination == .settings
                ) { selectDestination(.settings) }

                Button {
                    showsConnection = true
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: connection.isConnected ? "checkmark.circle.fill" : "link.badge.plus")
                            .foregroundStyle(connection.isConnected ? Color.green : Color.secondary)
                        Text(connection.statusLabel)
                            .lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(8)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    private var detail: some View {
        switch destination {
        case .talk:
            talkView
        case .work:
            workOverview
        case .memory:
            ShannonMemoryView(model: memory, showsDismissButton: false)
        case .settings:
            settingsView
        }
    }

    private var talkView: some View {
        VStack(spacing: 0) {
            talkHeader
            if let task = conversation.latestActiveAgentTask {
                DesktopWorkStrip(task: task) {
                    selectedTaskID = task.id
                    showsInspector = true
                }
            }
            Divider()

            ZStack(alignment: .bottom) {
                talkTimeline
                conversationBottomOverlay
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    @ViewBuilder
    private var talkTimeline: some View {
        if conversation.messages.isEmpty && !conversation.isLoadingHistory {
            ContentUnavailableView {
                Label("シャノンに話しかける", systemImage: "bubble.left")
            } description: {
                Text("相談、調査、文章、コード、そして実際の作業まで、ここから始められます。")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        ForEach(conversation.messages) { message in
                            DesktopMessageView(message: message)
                                .id(message.id)
                            if let session = conversation.organizeSession(sourceMessageID: message.id) {
                                ShannonOrganizeSessionCard(
                                    session: session,
                                    isWorking: conversation.pendingOrganizeSessionIDs.contains(session.id),
                                    error: conversation.organizeActionErrors[session.id],
                                    decide: { itemID, decision, title, details in
                                        Task {
                                            await conversation.decideOrganizeItem(
                                                sessionID: session.id, itemID: itemID,
                                                decision: decision, title: title, details: details
                                            )
                                        }
                                    },
                                    apply: { Task { await conversation.applyOrganizeSession(session.id) } }
                                )
                                .id("organize-session-\(session.id)")
                            }
                        }
                        if conversation.isSending {
                            HStack(spacing: 8) {
                                ShannonAvatarView(expression: .thinking, size: 26)
                                ProgressView().controlSize(.small)
                                Text("考えています").foregroundStyle(.secondary)
                            }
                        }
                    }
                    .frame(maxWidth: 820, alignment: .leading)
                    .padding(.horizontal, 34)
                    .padding(.top, 28)
                    .padding(.bottom, 150)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: conversation.messages.count) {
                    if let id = conversation.messages.last?.id {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
            }
        }
    }

    private var conversationBottomOverlay: some View {
        VStack(spacing: 8) {
            if let error = conversation.errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(error).font(.callout)
                    Spacer()
                    Button("閉じる") { conversation.dismissError() }
                        .buttonStyle(.borderless)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            DesktopComposer(model: conversation)
                .background {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay {
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.62))
                        }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(Color.primary.opacity(0.09), lineWidth: 0.75)
                }
                .shadow(color: .black.opacity(0.14), radius: 18, y: 7)
        }
        .frame(maxWidth: 820)
        .padding(.horizontal, 28)
        .padding(.bottom, 18)
        .padding(.top, 34)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) {
            LinearGradient(
                colors: [
                    Color(nsColor: .textBackgroundColor).opacity(0),
                    Color(nsColor: .textBackgroundColor).opacity(0.84),
                    Color(nsColor: .textBackgroundColor),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .allowsHitTesting(false)
        }
    }

    private var talkHeader: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.selectedThread?.title ?? "新しいトーク")
                    .font(.headline)
                    .lineLimit(1)
                Text("会話と作業はiPhoneと同じシャノンへ続きます")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 6) {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 7, height: 7)
                Text(DesktopExpressionLabel.label(for: conversation.currentExpression))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Button {
                selectedTaskID = conversation.latestActiveAgentTask?.id ?? conversation.agentTasks.first?.id
                showsInspector.toggle()
            } label: {
                Image(systemName: "sidebar.trailing")
            }
            .buttonStyle(.borderless)
            .help("現在地を表示")
        }
        .padding(.horizontal, 18)
        .frame(height: 58)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var workOverview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("作業全体")
                        .font(.largeTitle.weight(.semibold))
                    Text("何を目指し、いまどこにいて、次に何をするかを一つの面で見渡します。")
                        .foregroundStyle(.secondary)
                }

                if conversation.agentTasks.isEmpty {
                    ContentUnavailableView(
                        "進行中の作業はありません",
                        systemImage: "checkmark.circle",
                        description: Text("会話の中でシャノンに作業を依頼すると、ここに計画と現在地が表示されます。")
                    )
                    .frame(maxWidth: .infinity, minHeight: 320)
                } else {
                    DesktopTaskSection(
                        title: "いま",
                        subtitle: "進行・確認待ち・一時停止",
                        tasks: workProjection.active,
                        selectedTaskID: selectedTaskID,
                        select: selectTask
                    )
                    DesktopTaskSection(
                        title: "これから",
                        subtitle: "シャノンからの提案。開始はあなたが決めます",
                        tasks: workProjection.proposed,
                        selectedTaskID: selectedTaskID,
                        select: selectTask
                    )
                    DesktopTaskSection(
                        title: "完了",
                        subtitle: "検証結果と変更内容を残します",
                        tasks: workProjection.finished,
                        selectedTaskID: selectedTaskID,
                        select: selectTask
                    )
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .toolbar {
            Button {
                Task { await conversation.synchronizeAgentTasks() }
            } label: {
                Label("更新", systemImage: "arrow.clockwise")
            }
            Button {
                selectedTaskID = selectedTaskID ?? conversation.latestActiveAgentTask?.id ?? conversation.agentTasks.first?.id
                showsInspector.toggle()
            } label: {
                Label("現在地", systemImage: "sidebar.trailing")
            }
        }
    }

    private var taskInspector: some View {
        Group {
            if let task = selectedTask {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack(spacing: 10) {
                            ShannonAvatarView(expression: task.expression, size: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("現在地")
                                    .font(.headline)
                                Text(task.status.japaneseName)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        DesktopInspectorSection(title: "目的") {
                            Text(task.goal)
                        }
                        DesktopInspectorSection(title: "いま") {
                            Text(task.currentAction ?? task.summary)
                            if let progress = task.progressFraction {
                                ProgressView(value: progress)
                                Text("全\(task.plan.count)工程中 \(task.completedPlanCount)工程完了")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        DesktopInspectorSection(title: "次") {
                            Text(ShannonDesktopWorkProjection.nextAction(for: task))
                        }
                        DesktopInspectorSection(title: "シャノンの様子") {
                            Label(
                                DesktopExpressionLabel.stateDescription(for: task.expression),
                                systemImage: "sparkles"
                            )
                            .foregroundStyle(.secondary)
                        }

                        if task.status == .proposed {
                            Button("この作業を始める") {
                                Task { await conversation.startAgentTask(task.id) }
                            }
                            .buttonStyle(.borderedProminent)
                        }

                        if let approval = task.pendingApproval {
                            VStack(alignment: .leading, spacing: 10) {
                                Label("あなたの確認が必要です", systemImage: "hand.raised.fill")
                                    .font(.headline)
                                Text(approval.title)
                                Text(approval.reason)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Button("許可") {
                                        Task { await conversation.resolveAgentApproval(task.id, accepted: true) }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    Button("許可しない") {
                                        Task { await conversation.resolveAgentApproval(task.id, accepted: false) }
                                    }
                                }
                            }
                            .padding(14)
                            .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                        }

                        if !task.plan.isEmpty {
                            DesktopInspectorSection(title: "計画") {
                                ForEach(task.plan) { item in
                                    Label(item.title, systemImage: item.status.symbolName)
                                        .foregroundStyle(item.status == .pending ? .secondary : .primary)
                                }
                            }
                        }
                    }
                    .padding(18)
                }
            } else {
                ContentUnavailableView(
                    "作業はありません",
                    systemImage: "sidebar.trailing",
                    description: Text("会話から作業を始めると、ここに現在地が表示されます。")
                )
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var settingsView: some View {
        Form {
            Section("外観") {
                Picker("表示", selection: $appearanceRawValue) {
                    ForEach(ShannonAppearanceMode.allCases) { mode in
                        Label(mode.japaneseName, systemImage: mode.symbolName)
                            .tag(mode.rawValue)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("接続") {
                LabeledContent("状態", value: connection.statusLabel)
                LabeledContent("通信", value: connection.verificationLabel)
                Button(connection.isConnected ? "接続情報を見る" : "シャノンへ接続") {
                    showsConnection = true
                }
            }

            Section("Shannon Desk") {
                LabeledContent("会話と記憶", value: "iPhoneと共通")
                LabeledContent("作業の正本", value: "Azureの永続タスク")
                Text("水色は操作面を染めず、シャノンの存在・感情・注意が必要な場所にだけ使います。")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(24)
        .navigationTitle("設定")
    }

    private func selectTask(_ task: ShannonAgentTask) {
        selectedTaskID = task.id
        showsInspector = true
    }

    private func selectDestination(_ destination: DesktopDestination) {
        destinationRawValue = destination.rawValue
    }

    private func focusThreadSearch() {
        selectDestination(.talk)
        focusedControl = .threadSearch
    }

    private func openFirstSearchResult() {
        guard let threadID = ShannonDesktopThreadSearch.firstResultID(
            in: conversation.threads,
            query: searchText
        ) else { return }
        Task {
            await conversation.selectThread(threadID)
            selectDestination(.talk)
        }
    }

    private func restoreSelectedThreadIfAvailable() async {
        guard let restoredThreadID,
              restoredThreadID != conversation.selectedThreadId,
              conversation.threads.contains(where: { $0.threadId == restoredThreadID }) else { return }
        await conversation.selectThread(restoredThreadID)
    }

    private func saveThreadRename() {
        guard let thread = renameThread else { return }
        let value = renameText
        renameThread = nil
        Task { _ = await conversation.renameThread(thread.threadId, title: value) }
    }
}

private struct DesktopSidebarButton: View {
    let title: String
    let symbol: String
    let badge: Int
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: symbol)
                    .frame(width: 18)
                Text(title)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fontWeight(selected ? .semibold : .regular)
        .foregroundStyle(selected ? .primary : .secondary)
    }
}

private struct DesktopWorkStrip: View {
    let task: ShannonAgentTask
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 0) {
                WorkStripValue(label: "目的", value: task.title)
                Divider().frame(height: 30)
                WorkStripValue(label: "いま", value: task.currentAction ?? task.summary)
                Divider().frame(height: 30)
                WorkStripValue(label: "次", value: ShannonDesktopWorkProjection.nextAction(for: task))
                Image(systemName: "chevron.right")
                    .foregroundStyle(.tertiary)
                    .padding(.trailing, 14)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color(nsColor: .textBackgroundColor))
    }
}

private struct WorkStripValue: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.caption)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

private struct DesktopMessageView: View {
    let message: ConversationMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 100)
                Text(message.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        } else {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    ShannonAvatarView(expression: message.emotionSnapshot?.expression ?? .neutral, size: 28)
                    Text("シャノン")
                        .font(.callout.weight(.semibold))
                    Text(DesktopExpressionLabel.label(for: message.emotionSnapshot?.expression ?? .neutral))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(message.text, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .help("返答をコピー")
                }
                DesktopMarkdownView(source: message.text)
                if !message.artifacts.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(Array(message.artifacts.enumerated()), id: \.offset) { _, artifact in
                            DesktopArtifactCard(artifact: artifact)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }
}

private struct DesktopArtifactCard: View {
    let artifact: ShannonGeneratedArtifactDTO
    @State private var isPreviewing = false

    private var safeFilename: String {
        ShannonGeneratedArtifact.safeFilename(artifact.name, mimeType: artifact.mimeType)
    }

    var body: some View {
        Button {
            isPreviewing = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: ShannonGeneratedArtifact.isMarkdown(artifact) ? "doc.richtext" : "doc.text")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 34, height: 34)
                    .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text(safeFilename)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                    Text(artifact.summary ?? ByteCountFormatter.string(
                        fromByteCount: Int64(artifact.content.utf8.count),
                        countStyle: .file
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer()
                Text("プレビュー")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 0.75)
        }
        .sheet(isPresented: $isPreviewing) {
            DesktopArtifactPreview(
                artifact: artifact,
                safeFilename: safeFilename
            )
            .frame(minWidth: 620, minHeight: 500)
        }
    }
}

private struct DesktopArtifactPreview: View {
    let artifact: ShannonGeneratedArtifactDTO
    let safeFilename: String
    @Environment(\.dismiss) private var dismiss
    @State private var isExporting = false
    @State private var exportMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(safeFilename).font(.headline)
                    Text("保存先を選ぶまでMacには書き込みません")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let exportMessage {
                    Text(exportMessage)
                        .font(.caption)
                        .foregroundStyle(exportMessage == "保存しました" ? Color.secondary : Color.orange)
                }
                Button("閉じる") { dismiss() }
                Button("保存…") { isExporting = true }
                    .buttonStyle(.borderedProminent)
            }
            .padding(16)
            Divider()
            ScrollView {
                Group {
                    if ShannonGeneratedArtifact.isMarkdown(artifact) {
                        DesktopMarkdownView(source: artifact.content)
                    } else {
                        Text(artifact.content)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(24)
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
        .fileExporter(
            isPresented: $isExporting,
            document: ShannonArtifactDocument(content: artifact.content),
            contentType: artifact.exportContentType,
            defaultFilename: safeFilename
        ) { result in
            switch result {
            case .success:
                exportMessage = "保存しました"
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError {
                    exportMessage = "保存できませんでした: \(error.localizedDescription)"
                }
            }
        }
    }
}

private struct DesktopMarkdownView: View {
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(ShannonMessageMarkdown.blocks(from: source).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: ShannonMessageMarkdown.Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(ShannonMessageMarkdown.render(text))
                .font(level <= 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, level <= 2 ? 6 : 2)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•")
                Text(ShannonMessageMarkdown.render(text))
            }
        case .numbered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker).foregroundStyle(.secondary)
                Text(ShannonMessageMarkdown.render(text))
            }
        case .quote(let text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accentColor)
                    .frame(width: 3)
                Text(ShannonMessageMarkdown.render(text))
                    .foregroundStyle(.secondary)
            }
        case .code(let text):
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
            }
            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
        case .divider:
            Divider()
        case .paragraph(let text):
            Text(ShannonMessageMarkdown.render(text))
        }
    }
}

private struct DesktopComposer: View {
    @Bindable var model: ShannonConversationModel
    @State private var attachments: [ShannonChatAttachmentDTO] = []
    @State private var isImporting = false
    @State private var attachmentError: String?
    @State private var usesWebSearch = false

    init(model: ShannonConversationModel) {
        self.model = model
#if DEBUG
        _attachments = State(initialValue: model.isDesignPreview ? [
            ShannonChatAttachmentDTO(
                name: "shannon-interface-plan.md",
                mimeType: "text/markdown",
                text: "# Shannon Desk\n会話と作業を一つの流れにする。"
            )
        ] : [])
        _usesWebSearch = State(initialValue: model.isDesignPreview)
#endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { index, attachment in
                            HStack(spacing: 7) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(attachment.name)
                                        .font(.caption.weight(.medium))
                                        .lineLimit(1)
                                    Text(ByteCountFormatter.string(
                                        fromByteCount: Int64(attachment.text.utf8.count),
                                        countStyle: .file
                                    ))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                }
                                Button {
                                    attachments.remove(at: index)
                                    attachmentError = nil
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.tertiary)
                                }
                                .buttonStyle(.plain)
                                .help("添付を外す")
                            }
                            .padding(.leading, 10)
                            .padding(.trailing, 7)
                            .padding(.vertical, 7)
                            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
            }

            if let attachmentError {
                Label(attachmentError, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if usesWebSearch {
                HStack(spacing: 7) {
                    Image(systemName: "globe")
                    Text("Webで調べる")
                        .font(.caption.weight(.medium))
                    Button {
                        usesWebSearch = false
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Web検索を外す")
                }
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color.accentColor.opacity(0.10), in: Capsule())
            }

            TextField("シャノンに話す", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .font(.body)

            HStack {
                Menu {
                    Button("ファイルを追加", systemImage: "paperclip") {
                        isImporting = true
                    }
                    Button(
                        usesWebSearch ? "Web検索を外す" : "Webで調べる",
                        systemImage: usesWebSearch ? "checkmark.circle" : "globe"
                    ) {
                        usesWebSearch.toggle()
                    }
                    Divider()
                    Text("テキスト・Markdown・コードを4件まで")
                    Text("Web検索は明示的に選んだ送信だけで使用")
                } label: {
                    Image(systemName: "plus")
                }
                .menuStyle(.borderlessButton)
                .help("ツール")

                Spacer()
                Text("⌘↩︎で送信")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Button {
                    let selectedAttachments = attachments
                    let selectedWebSearch = usesWebSearch
                    attachments = []
                    usesWebSearch = false
                    attachmentError = nil
                    Task {
                        await model.sendDraft(
                            attachments: selectedAttachments,
                            webSearch: selectedWebSearch
                        )
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(!model.canSendDraft(attachmentCount: attachments.count))
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(12)
        .frame(maxWidth: 780)
        .frame(maxWidth: .infinity)
        .fileImporter(
            isPresented: $isImporting,
            allowedContentTypes: [.plainText, .sourceCode, .json, .commaSeparatedText],
            allowsMultipleSelection: true
        ) { result in
            do {
                attachments = try ShannonDesktopAttachmentLoader.load(
                    urls: result.get(),
                    existing: attachments
                )
                attachmentError = nil
            } catch {
                attachmentError = (error as? LocalizedError)?.errorDescription
                    ?? "ファイルを追加できませんでした。"
            }
        }
        .onChange(of: model.selectedThreadId) {
            attachments = []
            usesWebSearch = false
            attachmentError = nil
        }
    }
}

private struct DesktopTaskSection: View {
    let title: String
    let subtitle: String
    let tasks: [ShannonAgentTask]
    let selectedTaskID: UUID?
    let select: (ShannonAgentTask) -> Void

    var body: some View {
        if !tasks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.title2.weight(.semibold))
                    Text(subtitle).font(.callout).foregroundStyle(.secondary)
                }
                VStack(spacing: 0) {
                    ForEach(tasks) { task in
                        Button { select(task) } label: {
                            HStack(spacing: 14) {
                                Image(systemName: task.status.symbolName)
                                    .foregroundStyle(task.status == .waitingApproval ? .orange : .secondary)
                                    .frame(width: 20)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(task.title).font(.headline)
                                        Text(task.status.japaneseName)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(task.currentAction ?? task.summary)
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                Spacer()
                                if let progress = task.progressFraction {
                                    ProgressView(value: progress)
                                        .frame(width: 90)
                                }
                                Image(systemName: "chevron.right")
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(selectedTaskID == task.id ? Color.accentColor.opacity(0.08) : .clear)
                        if task.id != tasks.last?.id { Divider().padding(.leading, 48) }
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

private struct DesktopInspectorSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
