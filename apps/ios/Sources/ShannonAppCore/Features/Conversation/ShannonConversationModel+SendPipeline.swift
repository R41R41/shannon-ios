import Foundation
import Observation

extension ShannonConversationModel {
    func send(
        text: String,
        userMessageID: UUID,
        attachments: [ShannonChatAttachmentDTO] = [],
        webSearch: Bool = false
    ) async {
        errorMessage = nil
        isSending = true
        let titleRevisionsAtSend = titleEditRevisions

        do {
            let response = try await client.send(
                message: text,
                scopeKey: scopeKey,
                threadId: selectedThreadId,
                attachments: attachments,
                webSearch: webSearch
            )
            updateDeliveryState(for: userMessageID, to: .sent)
            pendingAttachmentsByMessageID.removeValue(forKey: userMessageID)
            pendingWebSearchMessageIDs.remove(userMessageID)
            state = response.state
            selectedThreadId = response.threadId
            let emotion = response.messageEmotion
            let organizeSession = response.uiBlocks?.compactMap(\.session).first
            let replyMessage = ConversationMessage(
                id: organizeSession?.commandThroughMessageId.flatMap(UUID.init(uuidString:)) ?? UUID(),
                role: .shannon,
                text: response.reply,
                emotionSnapshot: ConversationMessage.EmotionSnapshot(
                    valence: emotion.valence,
                    arousal: emotion.arousal,
                    openness: emotion.openness,
                    expression: emotion.expression,
                    stateVersion: response.snapshotVersion
                ),
                artifacts: response.artifacts ?? []
            )
            messages.append(replyMessage)
            installAgentTaskProposals(
                response.uiBlocks ?? [],
                threadID: response.threadId,
                sourceMessageID: replyMessage.id
            )
            if let organizeSession { upsertOrganizeSession(organizeSession) }
            if let thread = response.thread, thread.threadId == response.threadId {
                let existing = threads.first { $0.threadId == thread.threadId }
                let editedDuringSend = titleRevisionsAtSend[thread.threadId, default: 0]
                    != titleEditRevisions[thread.threadId, default: 0]
                let updated = ChatThreadDTO(
                    threadId: thread.threadId,
                    title: editedDuringSend ? (existing?.title ?? thread.title) : thread.title,
                    createdAt: thread.createdAt,
                    updatedAt: thread.updatedAt,
                    messageCount: thread.messageCount,
                    summary: thread.summary ?? existing?.summary,
                    sections: thread.sections ?? existing?.sections
                )
                threads.removeAll { $0.threadId == updated.threadId }
                threads.insert(updated, at: 0)
                threadListRevision += 1
            }
            cacheCurrentHistory()
            persistDisplayCache()
            if response.thread == nil {
                // Older servers expose title changes through the existing thread-list API.
                await loadThreads(force: true)
            }
        } catch {
            updateDeliveryState(for: userMessageID, to: .failed)
            errorMessage = "シャノンに接続できませんでした。ローカルAPIを確認してください。"
        }
        isSending = false
    }

    static func messageText(
        text: String,
        attachments: [ShannonChatAttachmentDTO]
    ) -> String {
        let instruction = text.isEmpty ? "この添付資料を確認してください。" : text
        guard !attachments.isEmpty else { return instruction }
        let files = attachments.map { "📎 \($0.name)" }.joined(separator: "\n")
        return "\(instruction)\n\n\(files)"
    }

    func updateDeliveryState(for id: UUID, to deliveryState: ConversationMessage.DeliveryState) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index] = messages[index].withDeliveryState(deliveryState)
        cacheCurrentHistory()
        persistDisplayCache()
    }

    func markInitiativesRead() async {
        guard let threadId = selectedThreadId else { return }
        do {
            let markedRead = try await client.markInitiativesRead(scopeKey: scopeKey, threadId: threadId)
            guard markedRead > 0 else { return }
            unreadInitiativeCount = max(0, unreadInitiativeCount - markedRead)
            initiativeThreadIDs.remove(threadId)
        } catch {
            // It is safe to retry acknowledgement on the next foreground refresh.
        }
    }

    func cacheCurrentHistory() {
        guard let selectedThreadId else { return }
        cachedHistories[selectedThreadId] = messages.map(ShannonConversationCache.CachedMessage.init)
    }

    func persistDisplayCache() {
        cache?.save(.init(
            threads: threads,
            selectedThreadId: selectedThreadId,
            histories: cachedHistories,
            state: state
        ), scopeKey: scopeKey)
    }
}
