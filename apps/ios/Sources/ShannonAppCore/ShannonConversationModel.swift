import Foundation
import Observation

@MainActor
@Observable
public final class ShannonConversationModel {
    public var draft = ""
    public private(set) var messages: [ConversationMessage]
    public private(set) var threads: [ChatThreadDTO]
    public private(set) var selectedThreadId: String?
    public private(set) var state: CompanionStateDTO?
    public private(set) var isSending = false
    public private(set) var isLoadingHistory = false
    public private(set) var isLoadingThreads = false
    public private(set) var errorMessage: String?
    public private(set) var statusMessage: String?
    public private(set) var aetherProposalMessageIDs: Set<UUID> = []
    public private(set) var aetherSubmittedMessageIDs: Set<UUID> = []
    public private(set) var unreadInitiativeCount = 0
    public private(set) var initiativeThreadIDs: Set<String> = []
    public private(set) var talkPresentationRevision = 0
    public private(set) var agentTaskPresentationRevision = 0
    public private(set) var requestedAgentTaskPresentationID: UUID?
    public private(set) var agentTasks: [ShannonAgentTask]
    public private(set) var pendingAgentTaskActionIDs: Set<UUID> = []
    public private(set) var agentTaskActionErrors: [UUID: String] = [:]

    private let scopeKey: String
    private let client: any ShannonAPIClientProtocol
    private let cache: ShannonConversationCache?
    private let agentTaskStore: ShannonAgentTaskStore?
    private var cachedHistories: [String: [ShannonConversationCache.CachedMessage]]
    private var didAttemptInitialLoad = false
    private var didAttemptThreadsLoad = false
    private var previewAgentTaskIDs: Set<UUID> = []
    private var acknowledgedAgentTaskIDs: Set<UUID>

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
        self.agentTasks = shouldUseDisplayCache ? ShannonAgentTaskStore.standard.load(scopeKey: scopeKey) : []
        self.acknowledgedAgentTaskIDs = shouldUseDisplayCache
            ? ShannonAgentTaskStore.standard.loadAcknowledgedTaskIDs(scopeKey: scopeKey)
            : []
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

    public var selectedThread: ChatThreadDTO? {
        threads.first(where: { $0.threadId == selectedThreadId })
    }

    public var selectedThreadAgentTasks: [ShannonAgentTask] {
        guard let selectedThreadId else { return [] }
        return agentTasks
            .filter { $0.conversationThreadID == selectedThreadId }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    public var latestActiveAgentTask: ShannonAgentTask? {
        selectedThreadAgentTasks.first(where: { $0.status.isActive })
    }

    public var latestAgentTaskNotice: ShannonAgentTask? {
        agentTaskNotices.first
    }

    public var agentTaskNotices: [ShannonAgentTask] {
        agentTasks.filter { task in
            task.status.isActive
                || (task.status.isTerminal && !acknowledgedAgentTaskIDs.contains(task.id))
        }
    }

    public var agentTaskPollingKey: String {
        agentTasks.filter { $0.status.isActive }.map(\.id.uuidString).sorted().joined(separator: ",")
    }

    public var unreadAgentTaskCount: Int {
        agentTasks.filter { task in
            (task.status == .waitingApproval || task.status == .completed || task.status == .failed)
                && !acknowledgedAgentTaskIDs.contains(task.id)
        }.count
    }

    public var totalBadgeCount: Int {
        unreadInitiativeCount + unreadAgentTaskCount
    }

    public var unattachedSelectedThreadAgentTasks: [ShannonAgentTask] {
        let messageIDs = Set(messages.map(\.id))
        return selectedThreadAgentTasks.filter { task in
            guard let sourceMessageID = task.sourceMessageID else { return true }
            return !messageIDs.contains(sourceMessageID)
        }
    }

    public func agentTask(id: UUID) -> ShannonAgentTask? {
        agentTasks.first(where: { $0.id == id })
    }

    public func agentTask(sourceMessageID: UUID) -> ShannonAgentTask? {
        selectedThreadAgentTasks.first(where: { $0.sourceMessageID == sourceMessageID })
    }

    public func isAgentTaskActionInFlight(_ id: UUID) -> Bool {
        pendingAgentTaskActionIDs.contains(id)
    }

    public func agentTaskActionError(_ id: UUID) -> String? {
        agentTaskActionErrors[id]
    }

    public func dismissAgentTaskActionError(_ id: UUID) {
        agentTaskActionErrors.removeValue(forKey: id)
    }

    public func sendDraft() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        draft = ""
        let message = ConversationMessage(role: .user, text: text, deliveryState: .sending)
        messages.append(message)
        await send(text: text, userMessageID: message.id)
    }

    public func loadThreadsIfNeeded() async {
        guard !didAttemptThreadsLoad else { return }
        didAttemptThreadsLoad = true
        await loadThreads(force: true)
    }

    public func loadThreads(force: Bool) async {
        guard force || threads.isEmpty else { return }
        isLoadingThreads = true
        defer { isLoadingThreads = false }

        do {
            let threadList = try await client.loadThreads(scopeKey: scopeKey)
            threads = threadList.threads
            if selectedThreadId == nil, let latest = threads.first {
                selectedThreadId = latest.threadId
            }
            persistDisplayCache()
        } catch {
            return
        }
    }

    public func loadConversationIfNeeded() async {
        guard !didAttemptInitialLoad else { return }
        didAttemptInitialLoad = true
        await loadThreads(force: true)
        let selected = selectedThreadId ?? threads.first?.threadId
        await reloadConversation(threadId: selected)
        await synchronizeAgentTasks()
    }

    public func selectThread(_ threadId: String?) async {
        guard threadId != selectedThreadId else {
            await acknowledgeVisibleInitiatives()
            return
        }
        cacheCurrentHistory()
        selectedThreadId = threadId
        messages = threadId.flatMap { cachedHistories[$0]?.map(\.message) } ?? []
        await reloadConversation(threadId: threadId)
        await acknowledgeVisibleInitiatives()
    }

    public func createThread(title: String?) async {
        do {
            let threadId = try await client.createThread(scopeKey: scopeKey, title: title)
            selectedThreadId = threadId
            let threadItem = ChatThreadDTO(
                threadId: threadId,
                title: title ?? "新しいトーク",
                createdAt: Self.isoNow,
                updatedAt: Self.isoNow,
                messageCount: 0
            )
            threads.insert(threadItem, at: 0)
            messages = []
            persistDisplayCache()
            await reloadConversation(threadId: threadId)
        } catch {
            errorMessage = "新しいトークを作成できませんでした。"
        }
    }

    @discardableResult
    public func renameThread(_ threadId: String, title: String) async -> Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty, trimmedTitle.count <= 80 else {
            errorMessage = "トークのタイトルは1〜80文字で入力してください。"
            return false
        }

        do {
            try await client.renameThread(scopeKey: scopeKey, threadId: threadId, title: trimmedTitle)
            guard let index = threads.firstIndex(where: { $0.threadId == threadId }) else { return true }
            let existing = threads[index]
            threads[index] = ChatThreadDTO(
                threadId: existing.threadId,
                title: trimmedTitle,
                createdAt: existing.createdAt,
                updatedAt: existing.updatedAt,
                messageCount: existing.messageCount
            )
            persistDisplayCache()
            return true
        } catch {
            errorMessage = "トークのタイトルを保存できませんでした。"
            return false
        }
    }

    public func archiveThread(_ threadId: String) async {
        guard threads.count > 1 else {
            errorMessage = "最後のトークはアーカイブできません。"
            return
        }
        do {
            try await client.archiveThread(scopeKey: scopeKey, threadId: threadId)
            threads.removeAll { $0.threadId == threadId }
            cachedHistories.removeValue(forKey: threadId)
            agentTasks.removeAll { $0.conversationThreadID == threadId }
            if selectedThreadId == threadId {
                selectedThreadId = threads.first?.threadId
                messages = selectedThreadId.flatMap { cachedHistories[$0]?.map(\.message) } ?? []
                await reloadConversation(threadId: selectedThreadId)
            }
            persistDisplayCache()
            persistAgentTasks()
        } catch {
            errorMessage = "トークをアーカイブできませんでした。"
        }
    }

    public func reloadConversation(threadId: String? = nil) async {
        isLoadingHistory = true
        defer { isLoadingHistory = false }

        do {
            let response = try await client.loadConversation(scopeKey: scopeKey, threadId: threadId)
            selectedThreadId = response.threadId
            messages = response.messages.compactMap(Self.conversationMessage)
            state = response.state
            await loadThreads(force: true)

            if let selected = threads.firstIndex(where: { $0.threadId == response.threadId }) {
                let thread = threads.remove(at: selected)
                threads.insert(thread, at: 0)
            } else {
                threads.insert(
                    ChatThreadDTO(
                        threadId: response.threadId,
                        title: threadTitleForLoadedMessages,
                        createdAt: Self.isoNow,
                        updatedAt: Self.isoNow,
                        messageCount: response.messages.count,
                    ),
                    at: 0,
                )
            }
            cacheCurrentHistory()
            persistDisplayCache()
        } catch {
            if messages.isEmpty {
                errorMessage = "以前の会話を読み込めませんでした。新しい会話はそのまま始められます。"
            }
        }
    }

    public func retryLastFailed() async {
        guard !isSending,
              let message = messages.last(where: { $0.role == .user && $0.deliveryState == .failed })
        else { return }

        updateDeliveryState(for: message.id, to: .sending)
        await send(text: message.text, userMessageID: message.id)
    }

    public func dismissError() {
        errorMessage = nil
    }

    public func dismissStatus() {
        statusMessage = nil
    }

    @discardableResult
    public func installAgentTaskFixture(status: ShannonAgentTaskStatus = .proposed) -> UUID {
        let threadID = selectedThreadId ?? "local-preview"
        let sourceMessageID = messages.last(where: { $0.role == .shannon })?.id
        let task: ShannonAgentTask
        switch status {
        case .proposed, .queued, .starting, .paused, .failed, .cancelled:
            var proposed = ShannonAgentTaskFixtures.proposed(
                threadID: threadID,
                sourceMessageID: sourceMessageID
            )
            proposed.status = status
            task = proposed
        case .running:
            task = ShannonAgentTaskFixtures.running(threadID: threadID, sourceMessageID: sourceMessageID)
        case .waitingApproval:
            task = ShannonAgentTaskFixtures.waitingApproval(threadID: threadID, sourceMessageID: sourceMessageID)
        case .completed:
            task = ShannonAgentTaskFixtures.completed(threadID: threadID, sourceMessageID: sourceMessageID)
        }
        upsertAgentTask(task)
        previewAgentTaskIDs.insert(task.id)
        return task.id
    }

    public func startAgentTask(_ id: UUID) async {
        guard var task = agentTask(id: id), task.canTransition(to: .running) else { return }
        if !previewAgentTaskIDs.contains(id) {
            guard !pendingAgentTaskActionIDs.contains(id) else { return }
            pendingAgentTaskActionIDs.insert(id)
            defer { pendingAgentTaskActionIDs.remove(id) }
            let previous = task
            task.status = .queued
            task.summary = "作業をお願いしているところ。"
            task.currentAction = "作業環境の空きを確認中"
            task.updatedAt = Date()
            upsertAgentTask(task)
            do {
                let remote = try await client.createAgentTask(
                    scopeKey: scopeKey,
                    task: previous,
                    idempotencyKey: "ios-start-\(id.uuidString.lowercased())"
                )
                upsertAgentTask(remote)
            } catch {
                upsertAgentTask(previous)
                errorMessage = "作業を開始できませんでした。接続を確認してもう一度お試しください。"
            }
            return
        }
        let fixture = ShannonAgentTaskFixtures.running(
            threadID: task.conversationThreadID,
            sourceMessageID: task.sourceMessageID
        )
        task.status = .running
        task.summary = fixture.summary
        task.currentAction = fixture.currentAction
        task.plan = fixture.plan
        task.timeline = fixture.timeline
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func cancelAgentTask(_ id: UUID) async {
        guard var task = agentTask(id: id), task.canTransition(to: .cancelled) else { return }
        if task.status != .proposed && !previewAgentTaskIDs.contains(id) {
            await performAgentTaskCommand(
                id,
                type: "interrupt",
                payload: ["cancel": "true"],
                failureMessage: "作業を中止できませんでした。通信状態を確認してもう一度お試しください。",
                optimisticUpdate: { optimistic in
                    optimistic.summary = "停止を送信しています。"
                    optimistic.currentAction = "作業環境へ停止命令を送信中"
                }
            )
            return
        }
        task.status = .cancelled
        task.summary = "この作業は始めないことにした。"
        task.currentAction = nil
        task.pendingApproval = nil
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func toggleAgentTaskPause(_ id: UUID) async {
        guard var task = agentTask(id: id) else { return }
        let target: ShannonAgentTaskStatus = task.status == .paused ? .running : .paused
        guard task.canTransition(to: target) else { return }
        if !previewAgentTaskIDs.contains(id) {
            await performAgentTaskCommand(
                id,
                type: task.status == .paused ? "resume" : "interrupt",
                payload: [:],
                failureMessage: task.status == .paused ? "作業を再開できませんでした。" : "作業を一時停止できませんでした。"
            )
            return
        }
        task.status = target
        task.summary = target == .paused ? "ここでいったん止まってる。" : "作業を再開した。"
        task.currentAction = target == .paused ? nil : "既存の対話履歴を壊さないか確認中"
        task.timeline.append(.init(
            sequence: nextAgentSequence(task),
            title: target == .paused ? "ユーザーが一時停止" : "作業を再開",
            tone: target == .paused ? .warning : .progress
        ))
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func resolveAgentApproval(_ id: UUID, accepted: Bool, forSession: Bool = false) async {
        guard var task = agentTask(id: id), task.status == .waitingApproval else { return }
        if !previewAgentTaskIDs.contains(id) {
            let decision = accepted ? (forSession ? "allow_session" : "allow_once") : "deny"
            if task.pendingApproval == nil {
                await synchronizeAgentTask(id)
                guard let refreshed = agentTask(id: id), refreshed.status == .waitingApproval else {
                    agentTaskActionErrors[id] = "最新の作業状態を取得できませんでした。もう一度お試しください。"
                    return
                }
                task = refreshed
            }
            guard let externalRequestID = task.pendingApproval?.externalRequestID else {
                agentTaskActionErrors[id] = "許可内容を取得できませんでした。作業一覧から開き直してください。"
                return
            }
            await performAgentTaskCommand(
                id,
                type: "resolve_approval",
                payload: ["decision": decision, "externalRequestID": externalRequestID],
                failureMessage: "判断を送信できませんでした。通信状態を確認してもう一度お試しください。",
                optimisticUpdate: { optimistic in
                    optimistic.summary = accepted ? "許可を送信しています。" : "判断を送信しています。"
                    optimistic.currentAction = "作業環境へ判断を送信中"
                }
            )
            return
        }
        task.pendingApproval = nil
        task.status = accepted ? .running : .cancelled
        task.summary = accepted ? "許可を受け取った。続きから進めるね。" : "許可されなかったので、ここで止めた。"
        task.currentAction = accepted ? "接続テストを実行中" : nil
        task.timeline.append(.init(
            sequence: nextAgentSequence(task),
            title: accepted
                ? (forSession ? "ユーザーがこの作業中の操作を許可" : "ユーザーが今回の操作を許可")
                : "ユーザーが操作を許可しなかった",
            tone: accepted ? .progress : .warning
        ))
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func steerAgentTask(_ id: UUID, instruction: String) async {
        let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              var task = agentTask(id: id),
              task.status == .running || task.status == .paused
        else { return }
        if !previewAgentTaskIDs.contains(id) {
            await performAgentTaskCommand(
                id,
                type: "steer",
                payload: ["instruction": trimmed],
                failureMessage: "追加の指示を送信できませんでした。"
            )
            return
        }
        if task.status == .paused { task.status = .running }
        task.summary = "追加の指示を受け取った。"
        task.currentAction = trimmed
        task.timeline.append(.init(
            sequence: nextAgentSequence(task),
            title: "ユーザーから追加の指示",
            detail: trimmed,
            tone: .progress
        ))
        task.updatedAt = Date()
        upsertAgentTask(task)
    }

    public func synchronizeAgentTasks() async {
        do {
            let remoteTasks = try await client.loadAgentTasks(scopeKey: scopeKey)
            let remoteIDs = Set(remoteTasks.map(\.id))
            let localOnly = agentTasks.filter {
                ($0.status == .proposed || previewAgentTaskIDs.contains($0.id)) && !remoteIDs.contains($0.id)
            }
            agentTasks = (remoteTasks + localOnly).sorted { $0.updatedAt > $1.updatedAt }
            persistAgentTasks()
        } catch {
            // The on-device projection remains usable while the API is offline.
        }
    }

    public func synchronizeAgentTask(_ id: UUID) async {
        guard !previewAgentTaskIDs.contains(id), let current = agentTask(id: id) else { return }
        do {
            let sequence = current.timeline.map(\.sequence).max()
            if let remote = try await client.loadAgentTask(scopeKey: scopeKey, taskID: id, afterSequence: sequence) {
                upsertAgentTask(remote)
            }
        } catch {
            // Polling is best effort; command actions surface their own errors.
        }
    }

    public func acknowledgeAgentTask(_ id: UUID) {
        acknowledgedAgentTaskIDs.insert(id)
        agentTaskStore?.saveAcknowledgedTaskIDs(acknowledgedAgentTaskIDs, scopeKey: scopeKey)
    }

    public func openAgentTaskNotification(_ id: UUID) async {
        await synchronizeAgentTasks()
        guard agentTask(id: id) != nil else { return }
        acknowledgeAgentTask(id)
        requestedAgentTaskPresentationID = id
        agentTaskPresentationRevision &+= 1
        talkPresentationRevision &+= 1
    }

    public func advanceAgentTaskFixture(_ id: UUID) {
        guard let task = agentTask(id: id) else { return }
        let next: ShannonAgentTask
        switch task.status {
        case .proposed, .queued, .starting, .paused:
            next = ShannonAgentTaskFixtures.running(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        case .running:
            next = ShannonAgentTaskFixtures.waitingApproval(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        case .waitingApproval:
            next = ShannonAgentTaskFixtures.completed(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        case .completed, .failed, .cancelled:
            next = ShannonAgentTaskFixtures.proposed(
                threadID: task.conversationThreadID,
                sourceMessageID: task.sourceMessageID
            )
        }
        var replacement = ShannonAgentTask(
            id: task.id,
            conversationThreadID: next.conversationThreadID,
            sourceMessageID: next.sourceMessageID,
            title: next.title,
            goal: next.goal,
            hostHint: task.hostHint,
            projectHint: task.projectHint,
            status: next.status,
            summary: next.summary,
            currentAction: next.currentAction,
            plan: next.plan,
            timeline: next.timeline,
            pendingApproval: next.pendingApproval,
            changes: next.changes,
            tests: next.tests,
            createdAt: task.createdAt,
            updatedAt: Date()
        )
        replacement.updatedAt = Date()
        upsertAgentTask(replacement)
    }

    public func sendToAether(_ message: ConversationMessage) async {
        guard message.role == .shannon,
              !aetherProposalMessageIDs.contains(message.id),
              !aetherSubmittedMessageIDs.contains(message.id) else { return }
        aetherProposalMessageIDs.insert(message.id)
        defer { aetherProposalMessageIDs.remove(message.id) }
        do {
            let compactTitle = message.text
                .split(whereSeparator: { $0.isNewline })
                .first
                .map(String.init)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? "Shannonからの提案"
            _ = try await client.createAetherProposal(
                scopeKey: scopeKey,
                title: String(compactTitle.prefix(120)),
                content: message.text,
                reason: "Shannonの返答から手動で送信"
            )
            aetherSubmittedMessageIDs.insert(message.id)
            statusMessage = "Aetherの提案箱へ送りました。"
        } catch {
            errorMessage = "Aetherへ送れませんでした。連携設定を確認してください。"
        }
    }

    public func refreshInitiatives() async {
        do {
            let inbox = try await client.loadInitiatives(scopeKey: scopeKey)
            unreadInitiativeCount = inbox.unreadCount
            initiativeThreadIDs = Set(inbox.messages.map(\.threadId))
            guard let latest = inbox.messages.last else { return }
            await loadThreads(force: true)
            if selectedThreadId == nil || selectedThreadId == latest.threadId {
                await reloadConversation(threadId: latest.threadId)
            }
        } catch {
            // Initiative polling must never make ordinary conversation look offline.
        }
    }

    public func acknowledgeVisibleInitiatives() async {
        guard let selectedThreadId,
              unreadInitiativeCount > 0,
              initiativeThreadIDs.contains(selectedThreadId)
        else { return }
        await markInitiativesRead()
    }

    @discardableResult
    public func registerPushToken(
        _ deviceToken: String,
        environment: ShannonPushEnvironmentDTO
    ) async -> Bool {
        do {
            try await client.registerPushToken(
                scopeKey: scopeKey,
                deviceToken: deviceToken,
                environment: environment
            )
            return true
        } catch {
            // Registration is retried on the next foreground activation.
            return false
        }
    }

    public func openInitiativeThread(_ threadId: String) async {
        await selectThread(threadId)
        talkPresentationRevision &+= 1
    }

    public var canSendDraft: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending && !isLoadingHistory
    }

    public var currentExpression: ShannonExpressionDTO {
        messages
            .last(where: { $0.role == .shannon })?
            .emotionSnapshot?
            .expression ?? .curious
    }

    public var hasFailedMessage: Bool {
        messages.contains { $0.role == .user && $0.deliveryState == .failed }
    }

    public var latestContextReference: ActiveMemoryDTO? {
        state?.activeMemories
            .filter { $0.relevance >= 0.45 }
            .max(by: { $0.relevance < $1.relevance })
    }

    private func send(text: String, userMessageID: UUID) async {
        errorMessage = nil
        isSending = true

        do {
            let response = try await client.send(message: text, scopeKey: scopeKey, threadId: selectedThreadId)
            updateDeliveryState(for: userMessageID, to: .sent)
            state = response.state
            selectedThreadId = response.threadId
            let emotion = response.messageEmotion
            let replyMessage = ConversationMessage(
                role: .shannon,
                text: response.reply,
                emotionSnapshot: ConversationMessage.EmotionSnapshot(
                    valence: emotion.valence,
                    arousal: emotion.arousal,
                    openness: emotion.openness,
                    expression: emotion.expression,
                    stateVersion: response.snapshotVersion
                )
            )
            messages.append(replyMessage)
            installAgentTaskProposals(
                response.uiBlocks ?? [],
                threadID: response.threadId,
                sourceMessageID: replyMessage.id
            )
            cacheCurrentHistory()
            persistDisplayCache()
            await loadThreads(force: true)
        } catch {
            updateDeliveryState(for: userMessageID, to: .failed)
            errorMessage = "シャノンに接続できませんでした。ローカルAPIを確認してください。"
        }
        isSending = false
    }

    private func updateDeliveryState(for id: UUID, to deliveryState: ConversationMessage.DeliveryState) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index] = messages[index].withDeliveryState(deliveryState)
        cacheCurrentHistory()
        persistDisplayCache()
    }

    private func markInitiativesRead() async {
        do {
            _ = try await client.markInitiativesRead(scopeKey: scopeKey)
            unreadInitiativeCount = 0
            initiativeThreadIDs.removeAll()
        } catch {
            // It is safe to retry acknowledgement on the next foreground refresh.
        }
    }

    private func cacheCurrentHistory() {
        guard let selectedThreadId else { return }
        cachedHistories[selectedThreadId] = messages.map(ShannonConversationCache.CachedMessage.init)
    }

    private func persistDisplayCache() {
        cache?.save(.init(
            threads: threads,
            selectedThreadId: selectedThreadId,
            histories: cachedHistories,
            state: state
        ), scopeKey: scopeKey)
    }

    private func upsertAgentTask(_ task: ShannonAgentTask) {
        if let index = agentTasks.firstIndex(where: { $0.id == task.id }) {
            agentTasks[index] = task
        } else {
            agentTasks.append(task)
        }
        agentTasks.sort { $0.updatedAt > $1.updatedAt }
        persistAgentTasks()
    }

    private func persistAgentTasks() {
        agentTaskStore?.save(agentTasks, scopeKey: scopeKey)
    }

    private func performAgentTaskCommand(
        _ id: UUID,
        type: String,
        payload: [String: String],
        failureMessage: String,
        optimisticUpdate: ((inout ShannonAgentTask) -> Void)? = nil
    ) async {
        guard let previous = agentTask(id: id) else { return }
        guard !pendingAgentTaskActionIDs.contains(id) else { return }
        agentTaskActionErrors.removeValue(forKey: id)
        pendingAgentTaskActionIDs.insert(id)
        defer { pendingAgentTaskActionIDs.remove(id) }
        if let optimisticUpdate {
            var optimistic = previous
            optimisticUpdate(&optimistic)
            optimistic.updatedAt = Date()
            upsertAgentTask(optimistic)
        }
        do {
            let remote = try await client.sendAgentTaskCommand(
                scopeKey: scopeKey,
                taskID: id,
                type: type,
                payload: payload,
                idempotencyKey: "ios-command-\(UUID().uuidString.lowercased())"
            )
            upsertAgentTask(remote)
        } catch {
            upsertAgentTask(previous)
            agentTaskActionErrors[id] = failureMessage
            errorMessage = failureMessage
        }
    }

    private func installAgentTaskProposals(
        _ blocks: [ShannonUIBlockDTO],
        threadID: String,
        sourceMessageID: UUID
    ) {
        for block in blocks where block.type == "agent_task_proposal" {
            let detail = [block.goal, block.risk].compactMap { value in
                guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return value
            }.joined(separator: "\n")
            let task = ShannonAgentTask(
                id: block.proposalId.flatMap(UUID.init(uuidString:)) ?? UUID(),
                conversationThreadID: threadID,
                sourceMessageID: sourceMessageID,
                title: block.title,
                goal: block.goal,
                hostHint: block.hostHint,
                projectHint: block.projectHint,
                status: .proposed,
                summary: detail.isEmpty ? block.goal : detail
            )
            upsertAgentTask(task)
        }
    }

    private func nextAgentSequence(_ task: ShannonAgentTask) -> Int {
        (task.timeline.map(\.sequence).max() ?? 0) + 1
    }

    private static func conversationMessage(_ message: StoredConversationMessageDTO) -> ConversationMessage? {
        let role: ConversationMessage.Role
        switch message.role {
        case "user": role = .user
        case "assistant": role = .shannon
        default: return nil
        }
        let emotionSnapshot = message.messageEmotion.flatMap { emotion in
            message.stateVersion.map { version in
                ConversationMessage.EmotionSnapshot(
                    valence: emotion.valence,
                    arousal: emotion.arousal,
                    openness: emotion.openness,
                    expression: emotion.expression,
                    stateVersion: version
                )
            }
        }
        return ConversationMessage(
            id: UUID(uuidString: message.id) ?? UUID(),
            role: role,
            text: message.content,
            sentAt: parseDate(message.observedAt),
            emotionSnapshot: emotionSnapshot
        )
    }

    private var threadTitleForLoadedMessages: String {
        if let firstUserMessage = messages.compactMap({
            switch $0.role {
            case .user: return $0.text
            case .shannon: return nil
            }
        }).first {
            return firstUserMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "新しいトーク"
                : String(firstUserMessage.prefix(40))
        }
        return "新しいトーク"
    }

    private static func parseDate(_ value: String) -> Date {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let parsed = try? fractional.parse(value) { return parsed }
        if let parsed = try? Date.ISO8601FormatStyle().parse(value) { return parsed }
        return Date()
    }

    private static var isoNow: String {
        Date().formatted(.iso8601)
    }
}
