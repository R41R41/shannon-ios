import Foundation
import Observation

extension ShannonConversationModel {
    public func loadThreadsIfNeeded() async {
        guard !didAttemptThreadsLoad else { return }
        didAttemptThreadsLoad = true
        await loadThreads(force: true)
    }

    public func loadThreads(force: Bool) async {
        guard force || threads.isEmpty else { return }
        isLoadingThreads = true
        defer { isLoadingThreads = false }
        let revision = threadListRevision

        do {
            let threadList = try await client.loadThreads(scopeKey: scopeKey)
            guard revision == threadListRevision else { return }
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
        // A reply held at her pace goes in whole into its own Talk before another is shown (ADR-0013 item 10).
        flushPacedReply()
        cacheCurrentHistory()
        selectedThreadId = threadId
        messages = threadId.flatMap { cachedHistories[$0]?.map(\.message) } ?? []
#if DEBUG
        if isDesignPreview {
            errorMessage = nil
            return
        }
#endif
        await reloadConversation(threadId: threadId)
        await acknowledgeVisibleInitiatives()
    }

    public func createThread(title: String?) async {
        do {
            let threadId = try await client.createThread(scopeKey: scopeKey, title: title)
            flushPacedReply()
            cacheCurrentHistory()
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

        threadListRevision += 1
        defer {
            threadListRevision += 1
        }
        do {
            try await client.renameThread(scopeKey: scopeKey, threadId: threadId, title: trimmedTitle)
            titleEditRevisions[threadId, default: 0] += 1
            guard let index = threads.firstIndex(where: { $0.threadId == threadId }) else { return true }
            let existing = threads[index]
            threads[index] = ChatThreadDTO(
                threadId: existing.threadId,
                title: trimmedTitle,
                createdAt: existing.createdAt,
                updatedAt: existing.updatedAt,
                messageCount: existing.messageCount,
                summary: existing.summary,
                sections: existing.sections
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
                flushPacedReply()
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
        historyLoadRevision += 1
        let revision = historyLoadRevision
        let selectionAtStart = selectedThreadId
        isLoadingHistory = true
        defer { if revision == historyLoadRevision { isLoadingHistory = false } }

        do {
            let response = try await client.loadConversation(scopeKey: scopeKey, threadId: threadId)
            guard revision == historyLoadRevision, selectedThreadId == selectionAtStart else { return }
            // The stored Talk has the held reply already: the pace ends here, and nothing is put in twice.
            flushPacedReply()
            selectedThreadId = response.threadId
            messages = response.messages.compactMap(Self.conversationMessage)
            feedback.setContext(threadID: response.threadId, othersPresent: feedback.othersPresent)
            feedback.install(response.messages.compactMap(\.feedback), threadID: response.threadId)
            state = response.state
            let sessions = (try? await client.loadOrganizeSessions(
                scopeKey: scopeKey, threadId: response.threadId
            )) ?? []
            guard revision == historyLoadRevision, selectedThreadId == response.threadId else { return }
            organizeSessions = sessions
            await loadThreads(force: true)
            guard revision == historyLoadRevision, selectedThreadId == response.threadId else { return }

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
            guard revision == historyLoadRevision, selectedThreadId == selectionAtStart else { return }
            if messages.isEmpty {
                errorMessage = "以前の会話を読み込めませんでした。新しい会話はそのまま始められます。"
            }
        }
    }

    public func retryLastFailed() async {
        guard !isSending, !isCheckingUncertainTurn,
              let message = messages.last(where: { $0.role == .user && $0.deliveryState == .failed })
        else { return }

        if uncertainTurns[message.id] != nil {
            // Idempotent 再送: a turn the server finished without this device is shown, never made a second time.
            switch await confirmUncertainTurnBeforeResend(message.id) {
            case .recovered:
                return
            case .unknown:
                // The Talk could not be read: the next 再送 sends, so a broken read never blocks sending for good.
                uncertainTurns.removeValue(forKey: message.id)
                errorMessage = ShannonFailureCopy.streamUnconfirmed
                return
            case .absent:
                uncertainTurns.removeValue(forKey: message.id)
            }
            guard !isSending, messages.contains(where: { $0.id == message.id && $0.deliveryState == .failed }) else { return }
        }
        discardInterruptedReply(for: message.id)
        updateDeliveryState(for: message.id, to: .sending)
        await send(
            text: message.text,
            userMessageID: message.id,
            attachments: pendingAttachmentsByMessageID[message.id] ?? [],
            webSearch: pendingWebSearchMessageIDs.contains(message.id),
            photoJPEGData: pendingPhotoByMessageID[message.id]
        )
    }

    public func dismissError() {
        errorMessage = nil
    }

    public func dismissStatus() {
        statusMessage = nil
    }

}
