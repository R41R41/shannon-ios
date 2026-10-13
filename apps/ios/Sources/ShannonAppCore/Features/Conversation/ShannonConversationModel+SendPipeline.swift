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
        let sentAt = Date()
        let knownIdentities = knownTurnIdentities()
        let replyID = UUID()
        // A new send replaces a cut-off reply still on screen; its own message keeps 再送.
        if streamingReply?.phase == .interrupted { streamingReply = nil }
        uncertainTurnRecoveryTask?.cancel()
#if os(iOS)
        // A reply being written goes on for a little while after he leaves the app; iOS suspends it after that.
        let backgroundTime = ShannonBackgroundAssertion(name: "Shannon text reply")
        defer { backgroundTime.end() }
#endif

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
            let threadAtSend = selectedThreadId
            let placeLocation = await requestedPlaceLocation(for: text)
            beginStreamingReply(id: replyID, userMessageID: userMessageID, threadAtSend: threadAtSend)
            let response = try await sendChatTurn(
                message: text,
                threadId: threadAtSend,
                attachments: referenceAttachments,
                webSearch: webSearch,
                placeLocation: placeLocation,
                onProgress: { [weak self] progress in
                    await self?.streamingReplyDidGrow(replyID, progress)
                }
            )
            // `done` (or the JSON response) is the authority: the provisional row gives way to the reply it stands for.
            discardStreamingReply(replyID)
            updateDeliveryState(for: userMessageID, to: .sent)
            pendingAttachmentsByMessageID.removeValue(forKey: userMessageID)
            pendingPhotoByMessageID.removeValue(forKey: userMessageID)
            pendingWebSearchMessageIDs.remove(userMessageID)
            state = response.state
            selectedThreadId = response.threadId
            let organizeSession = response.uiBlocks?.compactMap(\.session).first
            let replyMessage = Self.reconciledReply(response, provisionalID: replyID)
            messages.append(replyMessage)
            feedback.setContext(threadID: response.threadId, othersPresent: feedback.othersPresent)
            feedback.install([response.feedback].compactMap { $0 }, threadID: response.threadId)
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
            // She looks through this app's camera: what she saw arrives as her next message.
            if let ask = response.appLook { Task { await performAppLook(ask) } }
            return response.reply
        } catch let retracted as ShannonChatStreamRetracted {
            // The server took back what it showed: every sentence of it goes (contract, "Errors").
            let threadAtSend = streamingThread(replyID)
            discardStreamingReply(replyID)
            updateDeliveryState(for: userMessageID, to: .failed)
            errorMessage = ShannonFailureCopy.streamRetracted
            if !retracted.turnWasNotStored {
                // STREAM_FAILED: the turn is complete and stored; the Talk has the reply.
                rememberUncertainTurn(
                    userMessageID, sentText: text, threadID: retracted.threadId ?? threadAtSend,
                    threadAtSend: threadAtSend, knownIdentities: knownIdentities, sentAt: sentAt, settlesBy: Date())
                isSending = false
                scheduleUncertainTurnRecovery(userMessageID)
                return nil
            }
        } catch let interrupted as ShannonChatStreamInterrupted {
            // The connection broke (or the app was suspended) before `done`. The server finishes the turn without
            // this device: what arrived stays, marked cut off, and the Talk is read until the turn shows up.
            let threadAtSend = streamingThread(replyID)
            keepInterruptedReply(replyID, partialText: interrupted.partialText)
            updateDeliveryState(for: userMessageID, to: .failed)
            errorMessage = ShannonFailureCopy.streamInterrupted
            rememberUncertainTurn(
                userMessageID, sentText: text, threadID: interrupted.threadId ?? threadAtSend,
                threadAtSend: threadAtSend, knownIdentities: knownIdentities, sentAt: sentAt,
                settlesBy: sentAt.addingTimeInterval(Self.serverTurnBudgetSeconds))
            isSending = false
            scheduleUncertainTurnRecovery(userMessageID)
            return nil
        } catch {
            discardStreamingReply(replyID)
            updateDeliveryState(for: userMessageID, to: .failed)
            errorMessage = ShannonFailureCopy.send(
                error,
                messageLength: text.count,
                includesPhoto: photoJPEGData != nil
            )
            if Self.sendMayHaveReachedServer(error) {
                // 再送 first looks for the turn in the Talk, so a turn the server did finish is not made twice.
                rememberUncertainTurn(
                    userMessageID, sentText: text, threadID: selectedThreadId, threadAtSend: selectedThreadId,
                    knownIdentities: knownIdentities, sentAt: sentAt, settlesBy: sentAt.addingTimeInterval(Self.serverTurnBudgetSeconds))
            }
        }
        isSending = false
        return nil
    }

    /// The server's budget for one text turn from its arrival (30 s, docs/chat-stream-contract.md "Timeouts"),
    /// with a margin for the network: until then a turn this device lost may still be stored.
    static let serverTurnBudgetSeconds: TimeInterval = 40

    private func streamingThread(_ replyID: UUID) -> String? {
        streamingReply?.id == replyID ? streamingReply?.threadAtSend : selectedThreadId
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
            unreadInitiativeMessages.removeAll { $0.threadId == threadId }
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
