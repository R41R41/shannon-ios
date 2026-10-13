import Foundation

extension ShannonConversationModel {
    /// What this turn tells the server about the camera. nil when the server in use cannot be answered:
    /// the turn is then what it was before the app could look.
    func appLookClientState() -> ShannonAppLookClientStateDTO? {
        client is any ShannonAppLookServing ? appLook.clientState() : nil
    }

    /// One text turn, saying what the camera can do when the server can ask for a look. A client that can read
    /// the reply as it is written does so and reports each sentence through `onProgress`
    /// (docs/chat-stream-contract.md); any other client sends the turn whole, as before.
    func sendChatTurn(
        message: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool,
        placeLocation: ShannonVoiceDeviceLocationDTO?,
        onProgress: ShannonChatStreamProgressHandler? = nil
    ) async throws -> ChatResponseDTO {
        if let onProgress, let streaming = client as? any ShannonChatStreamServing {
            return try await streaming.sendStreaming(
                message: message, scopeKey: scopeKey, threadId: threadId, attachments: attachments,
                webSearch: webSearch, placeLocation: placeLocation, appLook: appLookClientState(),
                onProgress: onProgress)
        }
        guard let server = client as? any ShannonAppLookServing else {
            return try await client.send(
                message: message, scopeKey: scopeKey, threadId: threadId,
                attachments: attachments, webSearch: webSearch, placeLocation: placeLocation)
        }
        return try await server.send(
            message: message, scopeKey: scopeKey, threadId: threadId, attachments: attachments,
            webSearch: webSearch, placeLocation: placeLocation, appLook: appLook.clientState())
    }

    /// Takes the one look the server asked for and returns what she says about it, which is then
    /// also in the Talk. The frame goes from the camera to this one request and is kept nowhere.
    @discardableResult
    public func performAppLook(_ ask: ShannonAppLookAskDTO) async -> String? {
        guard let server = client as? any ShannonAppLookServing else { return nil }
        let threadAtAsk = selectedThreadId
        guard let outcome = await appLook.look(ask) else {
            // The ask closed first: her line about it, if she had announced the look, is written by the server
            // a moment after the ask's own expiry, which this device stops two seconds short of.
            try? await Task.sleep(for: .seconds(4))
            await reloadAfterUnansweredLook(threadAtAsk)
            return nil
        }
        let answer: ShannonAppLookAnswerDTO = switch outcome {
        case let .seen(camera, frame): .seen(scopeKey: scopeKey, camera: camera, frame: frame)
        case let .refused(code): .refused(scopeKey: scopeKey, code: code)
        }
        do {
            // Sent from a task of its own: a look that was interrupted still tells the server so, at once.
            let answered = try await Task { try await server.answerAppLook(id: ask.id, answer: answer) }.value
            guard let message = answered.message else { return nil }
            appendAppLookMessage(message)
            // What she says about an interrupted look is in the Talk; it is not spoken over him.
            return Task.isCancelled ? nil : message.text
        } catch {
            await reloadAfterUnansweredLook(threadAtAsk)
            return nil
        }
    }

    /// Shows what the server stored about a look this app could not answer, when that Talk is still open and idle.
    private func reloadAfterUnansweredLook(_ threadId: String?) async {
        guard let threadId, selectedThreadId == threadId, !isSending else { return }
        await reloadConversation(threadId: threadId)
    }

    private func appendAppLookMessage(_ message: ShannonAppLookAnswerResponseDTO.Message) {
        let id = UUID(uuidString: message.id) ?? UUID()
        let said = ConversationMessage(id: id, role: .shannon, text: message.text)
        if selectedThreadId == message.threadId {
            guard !messages.contains(where: { $0.id == id }) else { return }
            messages.append(said)
            cacheCurrentHistory()
        } else {
            // A look can finish while another thread is open: it belongs to the Talk it was asked in.
            cachedHistories[message.threadId, default: []].append(ShannonConversationCache.CachedMessage(said))
        }
        persistDisplayCache()
    }
}
