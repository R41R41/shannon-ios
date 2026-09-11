import Foundation
import Observation

extension ShannonConversationModel {
    public func sendDraft(
        attachments: [ShannonChatAttachmentDTO] = [],
        webSearch: Bool = false
    ) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty), !isSending else { return }
        draft = ""
        let messageText = Self.messageText(text: text, attachments: attachments)
        let message = ConversationMessage(role: .user, text: messageText, deliveryState: .sending)
        messages.append(message)
        if !attachments.isEmpty {
            pendingAttachmentsByMessageID[message.id] = attachments
        }
        if webSearch {
            pendingWebSearchMessageIDs.insert(message.id)
        }
        await send(
            text: messageText,
            userMessageID: message.id,
            attachments: attachments,
            webSearch: webSearch
        )
    }

    public func transcribeVoice(_ recording: ShannonVoiceRecording) async throws -> String {
        defer { try? FileManager.default.removeItem(at: recording.fileURL) }
        let result = try await client.transcribeVoice(scopeKey: scopeKey, recording: recording)
        let value = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw ShannonAPIError.invalidResponse }
        return value
    }

    public func createRealtimeVoiceCall(offerSDP: String) async throws -> ShannonRealtimeVoiceCallDTO {
        let call = try await client.createRealtimeVoiceCall(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            offerSDP: offerSDP
        )
        selectedThreadId = call.threadID
        return call
    }

    public func commitRealtimeVoiceTurn(
        userTranscript: String,
        shannonTranscript: String
    ) async throws {
        let userText = userTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let shannonText = shannonTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userText.isEmpty, !shannonText.isEmpty else { throw ShannonAPIError.invalidResponse }
        let response = try await client.commitRealtimeVoiceTurn(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            userTranscript: userText,
            shannonTranscript: shannonText
        )
        selectedThreadId = response.threadId
        state = response.state
        let emotion = response.messageEmotion
        messages.append(ConversationMessage(role: .user, text: userText))
        messages.append(ConversationMessage(
            role: .shannon,
            text: shannonText,
            emotionSnapshot: ConversationMessage.EmotionSnapshot(
                valence: emotion.valence,
                arousal: emotion.arousal,
                openness: emotion.openness,
                expression: emotion.expression,
                stateVersion: response.state.version
            )
        ))
        cacheCurrentHistory()
        await loadThreads(force: true)
    }
}
