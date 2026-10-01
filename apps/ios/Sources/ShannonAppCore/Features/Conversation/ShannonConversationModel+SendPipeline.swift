import Foundation
import Observation

extension ShannonConversationModel {
    @discardableResult
    func send(
        text: String,
        userMessageID: UUID,
        attachments: [ShannonChatAttachmentDTO] = [],
        webSearch: Bool = false,
        photoJPEGData: Data? = nil
    ) async -> String? {
        errorMessage = nil
        isSending = true
        isSearchingMemory = ShannonMemoryRecallCue.matches(text)
        defer { isSearchingMemory = false }
        let titleRevisionsAtSend = titleEditRevisions

        do {
            var referenceAttachments = attachments
            if let photoJPEGData {
                let vision = try await client.analyzeVoiceCameraSnapshot(
                    scopeKey: scopeKey,
                    threadId: selectedThreadId,
                    jpegData: photoJPEGData
                )
                selectedThreadId = vision.threadId
                referenceAttachments.append(ShannonChatAttachmentDTO(
                    name: "写真の観察.txt",
                    mimeType: "text/plain",
                    text: "ユーザーが選んで共有した写真の視覚的な観察です。撮影時刻は不明です。\n\(vision.description)"
                ))
            }
            let response = try await client.send(
                message: text,
                scopeKey: scopeKey,
                threadId: selectedThreadId,
                attachments: referenceAttachments,
                webSearch: webSearch,
                placeLocation: await requestedPlaceLocation(for: text)
            )
            updateDeliveryState(for: userMessageID, to: .sent)
            pendingAttachmentsByMessageID.removeValue(forKey: userMessageID)
            pendingPhotoByMessageID.removeValue(forKey: userMessageID)
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
                artifacts: response.artifacts ?? [],
                places: response.uiBlocks?.flatMap { $0.places ?? [] } ?? [],
                turnID: response.turnId
            )
            messages.append(replyMessage)
            // The reply never waits for memory extraction; what was captured is fetched afterwards.
            scheduleCaptureRefresh()
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
            isSending = false
            return response.reply
        } catch {
            updateDeliveryState(for: userMessageID, to: .failed)
            errorMessage = photoJPEGData == nil
                ? "シャノンに接続できませんでした。ローカルAPIを確認してください。"
                : "写真を確認または送信できませんでした。再試行できます。"
        }
        isSending = false
        return nil
    }

    private func requestedPlaceLocation(for text: String) async -> ShannonVoiceDeviceLocationDTO? {
#if os(iOS)
        guard ShannonPlaceIntent.wantsNearbyPlaces(text) else { return nil }
        return await ShannonVoiceLocationProvider.shared.currentLocation()
#else
        return nil
#endif
    }

    static func messageText(
        text: String,
        attachments: [ShannonChatAttachmentDTO],
        includesPhoto: Bool = false
    ) -> String {
        let instruction = text.isEmpty
            ? (includesPhoto ? "この写真を見てください。" : "この添付資料を確認してください。")
            : text
        let references = attachments.map { "📎 \($0.name)" } + (includesPhoto ? ["📷 写真"] : [])
        guard !references.isEmpty else { return instruction }
        return "\(instruction)\n\n\(references.joined(separator: "\n"))"
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
