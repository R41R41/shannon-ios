import Foundation
import Observation

@MainActor
@Observable
public final class ShannonConversationModel {
    public var draft = ""
    public internal(set) var isDesignPreview = false
    public internal(set) var messages: [ConversationMessage]
    public internal(set) var threads: [ChatThreadDTO]
    public internal(set) var selectedThreadId: String?
    public internal(set) var state: CompanionStateDTO?
    public internal(set) var isSending = false
    /// True while a pending text reply includes a memory search (FTS, and semantic recall when enabled).
    public internal(set) var isSearchingMemory = false
    public internal(set) var isLoadingHistory = false
    public internal(set) var isLoadingThreads = false
    public internal(set) var errorMessage: String?
    public internal(set) var statusMessage: String?
    public internal(set) var aetherProposalMessageIDs: Set<UUID> = []
    public internal(set) var aetherSubmittedMessageIDs: Set<UUID> = []
    public internal(set) var unreadInitiativeCount = 0
    public internal(set) var initiativeThreadIDs: Set<String> = []
    public internal(set) var talkPresentationRevision = 0
    public internal(set) var agentTaskPresentationRevision = 0
    public internal(set) var requestedAgentTaskPresentationID: UUID?
    public internal(set) var agentTasks: [ShannonAgentTask]
    public internal(set) var pendingAgentTaskActionIDs: Set<UUID> = []
    public internal(set) var agentTaskActionErrors: [UUID: String] = [:]
    public internal(set) var agentWorkspace: ShannonAgentWorkspaceCatalogDTO = .unavailable
    public internal(set) var isLoadingAgentWorkspace = false
    public internal(set) var agentWorkspaceError: String?
    public internal(set) var agentProjectProvisioning: [ShannonAgentProjectProvisioningDTO] = []
    public internal(set) var isProvisioningAgentProject = false
    public internal(set) var agentProjectProvisioningError: String?
    public internal(set) var organizeSessions: [ShannonOrganizeSessionDTO] = []
    public internal(set) var pendingOrganizeSessionIDs: Set<String> = []
    public internal(set) var organizeActionErrors: [String: String] = [:]
    public internal(set) var voyagerTaskCandidatesByItemID: [String: [ShannonVoyagerTaskProjectionDTO]] = [:]
    public internal(set) var voyagerProjects: [ShannonVoyagerProjectProjectionDTO] = []
    public internal(set) var pendingVoyagerCatalogItemIDs: Set<String> = []
    public internal(set) var voyagerCatalogErrorsByItemID: [String: String] = [:]

    let scopeKey: String
    let client: any ShannonAPIClientProtocol
    let cache: ShannonConversationCache?
    let agentTaskStore: ShannonAgentTaskStore?
    var cachedHistories: [String: [ShannonConversationCache.CachedMessage]]
    var didAttemptInitialLoad = false
    var didAttemptThreadsLoad = false
    var previewAgentTaskIDs: Set<UUID> = []
    var agentTaskAcknowledgements: ShannonAgentTaskAcknowledgements
    var threadListRevision = 0
    var historyLoadRevision = 0
    var titleEditRevisions: [String: Int] = [:]
    var pendingAttachmentsByMessageID: [UUID: [ShannonChatAttachmentDTO]] = [:]
    var pendingPhotoByMessageID: [UUID: Data] = [:]
    var pendingWebSearchMessageIDs: Set<UUID> = []

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonAPIClientProtocol = ShannonAPIClient(),
        messages: [ConversationMessage] = [],
        usesDisplayCache: Bool? = nil
    ) {
        self.scopeKey = scopeKey
        self.client = client
        let shouldUseDisplayCache = usesDisplayCache ?? (client is ShannonAPIClient)
        self.cache = shouldUseDisplayCache ? .standard : nil
        self.agentTaskStore = shouldUseDisplayCache ? .standard : nil
        let saved = shouldUseDisplayCache ? ShannonConversationCache.standard.load(scopeKey: scopeKey) : nil
        let savedAgentTasks = shouldUseDisplayCache ? ShannonAgentTaskStore.standard.load(scopeKey: scopeKey) : []
        self.agentTasks = savedAgentTasks
        self.agentTaskAcknowledgements = shouldUseDisplayCache
            ? ShannonAgentTaskStore.standard.loadAcknowledgements(scopeKey: scopeKey, tasks: savedAgentTasks)
            : ShannonAgentTaskAcknowledgements()
        self.cachedHistories = saved?.histories ?? [:]
        self.threads = saved?.threads ?? []
        self.selectedThreadId = saved?.selectedThreadId
        self.state = saved?.state
        if !messages.isEmpty {
            self.messages = messages
        } else if let selected = saved?.selectedThreadId {
            self.messages = saved?.histories[selected]?.map(\.message) ?? []
        } else {
            self.messages = []
        }
    }

#if DEBUG
    public static func designPreview() -> ShannonConversationModel {
        let now = Date()
        let emotion = ConversationMessage.EmotionSnapshot(
            valence: 0.72,
            arousal: 0.42,
            openness: 0.80,
            expression: .curious,
            stateVersion: 42
        )
        let model = ShannonConversationModel(
            messages: [
                ConversationMessage(
                    role: .user,
                    text: "この画面の改善点を、実装順に整理して。",
                    sentAt: now.addingTimeInterval(-180)
                ),
                ConversationMessage(
                    role: .shannon,
                    text: """
                    ## まず直すところ

                    画面の土台を **端まで続く一枚の会話面** にします。操作は内容の上へ浮かせ、必要なときだけ意識に入るようにします。

                    1. 上下の不透明な帯をなくす
                    2. 入力欄を入力内容に合わせて広げる
                    3. 見出し・箇条書き・コードを読み分けられるようにする

                    > シャノンらしさは、青い操作色と表情付きアイコンに絞ります。

                    ```swift
                    conversation.extendsBehindSystemAreas = true
                    ```
                    """,
                    sentAt: now.addingTimeInterval(-120),
                    emotionSnapshot: emotion,
                    artifacts: [ShannonGeneratedArtifactDTO(
                        name: "shannon-interface-plan.md",
                        mimeType: "text/markdown",
                        content: "# Shannon Desk\n\n会話と作業を一つの流れにする。\n",
                        summary: "会話画面の改善方針"
                    )],
                    sourceAttribution: ShannonSourceAttributionDTO(
                        title: "Hacker News",
                        url: "https://news.ycombinator.com/",
                        reason: "今日の関心に近く、会話画面の設計に関係していたから。"
                    )
                ),
                ConversationMessage(
                    role: .user,
                    text: "入力欄もChatGPTみたいに自然にして。",
                    sentAt: now.addingTimeInterval(-70)
                ),
                ConversationMessage(
                    role: .shannon,
                    text: "空のときは一行、入力を始めたら本文と操作の二段に広がる形にします。音声入力とライブ音声も役割を分けて残します。",
                    sentAt: now.addingTimeInterval(-20),
                    emotionSnapshot: emotion
                ),
                ConversationMessage(
                    role: .user,
                    text: "サイドバーも画面の上下いっぱいまで続けて。",
                    sentAt: now.addingTimeInterval(-10)
                ),
                ConversationMessage(
                    role: .shannon,
                    text: "背景面だけを端まで延ばし、タイトルと操作はステータス表示やホームインジケータに重ならない位置へ保ちます。会話面とサイドバー面は一枚につながり、操作だけが安全な位置に残る構成です。",
                    sentAt: now,
                    emotionSnapshot: emotion
                ),
            ],
            usesDisplayCache: false
        )
        let stamp = ISO8601DateFormatter().string(from: now)
        model.threads = [
            ChatThreadDTO(threadId: "design-preview", title: "Shannon UIを改善", createdAt: stamp, updatedAt: stamp, messageCount: 6),
            ChatThreadDTO(threadId: "voice-preview", title: "ライブ音声を調整", createdAt: stamp, updatedAt: stamp, messageCount: 18),
            ChatThreadDTO(threadId: "roadmap-preview", title: "長期計画", createdAt: stamp, updatedAt: stamp, messageCount: 24),
        ]
        model.selectedThreadId = "design-preview"
        var runningTask = ShannonAgentTaskFixtures.running(
            threadID: "design-preview",
            sourceMessageID: model.messages.last(where: { $0.role == .shannon })?.id,
            now: now.addingTimeInterval(-45)
        )
        runningTask.title = "Shannon Deskを実装"
        runningTask.goal = "Macでも会話・記憶・作業が一人のシャノンとして続く状態にする"
        runningTask.summary = "会話・作業・記憶を共有モデルへ接続し、最初のネイティブ画面まで確認済み。"
        runningTask.currentAction = "生成物の会話内プレビューと安全な保存を接続済み"
        runningTask.plan = [
            .init(id: "design", title: "UIと情報設計を確定", status: .completed),
            .init(id: "shell", title: "macOSアプリの土台を作る", status: .completed),
            .init(id: "connect", title: "会話と作業を接続", status: .completed),
            .init(id: "verify", title: "実機相当のMacビルドを検証", status: .completed),
            .init(id: "polish", title: "会話面とサイドバーを調整", status: .completed),
            .init(id: "m1", title: "ファイル添付とWeb検索を接続", status: .completed),
            .init(id: "artifact", title: "生成物の保存とプレビューを接続", status: .completed),
            .init(id: "pairing", title: "Mac実接続と配布準備へ進む", status: .pending),
        ]
        runningTask.changes = [
            .init(
                displayName: "ShannonDesktopRootView+Development.swift",
                path: "apps/macos-app/ShannonDesk/Features/Development/ShannonDesktopRootView+Development.swift",
                summary: "固定幅の操作列を、ウィンドウ幅に応じて切り替わる開発画面へ変更",
                additions: 84,
                deletions: 61,
                diffPreview: """
                @@ -42,3 +42,7 @@
                -developmentHeader
                -developmentTaskList
                +GeometryReader { proxy in
                +    if layout.showsTaskNavigator {
                +        developmentSplitWorkspace
                +    } else {
                +        developmentCompactWorkspace
                +    }
                """
            ),
            .init(
                displayName: "ShannonDesktopDevelopmentComponents.swift",
                path: "apps/macos-app/ShannonDesk/Features/Development/ShannonDesktopDevelopmentComponents.swift",
                summary: "ファイル一覧と差分レビューをMac標準の選択UIへ整理",
                additions: 126,
                deletions: 38,
                diffPreview: """
                @@ -150,2 +150,5 @@
                -DevelopmentTaskChangeRow(change: change)
                +List(changes, selection: $selection) { change in
                +    DevelopmentReviewChangeRow(change: change)
                +}
                +DevelopmentReviewDetail(change: selectedChange)
                """
            ),
        ]
        runningTask.tests = [
            .init(name: "Mac開発画面", status: .passed, detail: "19件 + レイアウト3件"),
            .init(name: "狭幅レイアウト", status: .passed, detail: "480 / 640 / 719 pt"),
        ]
        runningTask.timeline.append(.init(
            sequence: (runningTask.timeline.last?.sequence ?? 0) + 1,
            title: "実行出力",
            detail: "Building ShannonDesk…\nTest Suite 'ShannonDeskTests' passed.\n** TEST SUCCEEDED **\n",
            occurredAt: now.addingTimeInterval(-8),
            tone: .progress,
            activity: .init(kind: .command, status: .completed)
        ))
        var proposedTask = ShannonAgentTaskFixtures.proposed(threadID: "design-preview", now: now.addingTimeInterval(-20))
        proposedTask.title = "Mac実接続と配布準備"
        proposedTask.goal = "同じShannonへ安全に接続し、Macへ導入できる完成単位へ進める"
        proposedTask.summary = "ペアリング、実API smoke、署名・配布経路を順に検証する。"
        var completedTask = ShannonAgentTaskFixtures.completed(threadID: "design-preview", now: now.addingTimeInterval(-3600))
        completedTask.title = "Build 42の安定確認"
        completedTask.goal = "入力欄と外観切替がクラッシュせず動くことを確認する"
        completedTask.summary = "入力・複数行・ライト／ダーク／システム切替を確認済み。"
        model.agentTasks = [runningTask, proposedTask, completedTask]
        model.agentWorkspace = ShannonAgentWorkspaceCatalogDTO(
            routing: .init(
                defaultPreference: .auto,
                resolvedHostId: "shannon-mac",
                explanation: "このMacが利用できるため、ローカルで実行します。"
            ),
            hosts: [
                .init(
                    hostId: "shannon-mac",
                    displayName: "このMac",
                    kind: .local,
                    capabilities: ["workspace-files", "workspace-diff", "workspace-git", "workspace-build"],
                    projects: ["aether", "shannon-ios", "voyager"],
                    models: [],
                    status: .available,
                    lastSeenAt: stamp
                ),
                .init(
                    hostId: "shannon-cloud",
                    displayName: "Cloud Agent Host",
                    kind: .cloud,
                    capabilities: ["workspace-files", "workspace-diff", "workspace-git", "workspace-build"],
                    projects: ["shannon-ios"],
                    models: [],
                    status: .available,
                    lastSeenAt: stamp
                ),
            ],
            projects: [
                .init(key: "aether", availableHostIds: ["shannon-mac"]),
                .init(
                    key: "shannon-ios",
                    availableHostIds: ["shannon-mac", "shannon-cloud"],
                    isGitRepository: true,
                    currentBranch: "feature/macos-development-workspace",
                    files: [
                        "apps/macos-app/ShannonDesk/ShannonDeskApp.swift",
                        "apps/macos-app/ShannonDesk/Features/Talk/ShannonDesktopRootView+Talk.swift",
                        "apps/ios/Sources/ShannonAppCore/Features/AgentTasks/ShannonAgentTask.swift",
                        "services/api/src/agentHost.ts",
                        "services/api/src/agentTaskStore.ts",
                    ],
                    changes: [
                        .init(path: "services/api/src/agentHost.ts", status: "M", additions: 18, deletions: 2),
                        .init(path: "apps/macos-app/ShannonDesk/ShannonDeskApp.swift", status: "M", additions: 12, deletions: 1),
                    ]
                ),
                .init(key: "voyager", availableHostIds: ["shannon-mac"]),
            ],
            models: [
                .init(
                    id: "gpt-5.6-sol",
                    displayName: "GPT-5.6 Sol",
                    description: "日常の開発作業向け",
                    supportedReasoningEfforts: [.low, .medium, .high, .xhigh, .max, .ultra],
                    defaultReasoningEffort: .high
                ),
            ]
        )
        model.didAttemptInitialLoad = true
        model.didAttemptThreadsLoad = true
        model.isDesignPreview = true
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewPlaces") {
            model.messages = [
                ConversationMessage(role: .user, text: "浜松の公園を地図で探して"),
                ConversationMessage(role: .shannon, text: "散歩しやすい公園を見つけたよ。", places: [
                    ShannonPlaceDTO(name: "浜松城公園", address: "静岡県浜松市中央区元城町100-2",
                                    reason: "街なかで散歩しやすい", mapQuery: "浜松城公園 静岡県浜松市",
                                    mapUrl: "https://maps.apple.com/?q=%E6%B5%9C%E6%9D%BE%E5%9F%8E%E5%85%AC%E5%9C%92"),
                ]),
            ]
            model.agentTasks = []
        }
        return model
    }
#endif
}
