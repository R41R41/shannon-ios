import Foundation
import Observation

@MainActor
@Observable
public final class ShannonConversationModel {
    public var draft = ""
    public private(set) var messages: [ConversationMessage]
    public private(set) var state: CompanionStateDTO?
    public private(set) var isSending = false
    public private(set) var errorMessage: String?

    private let scopeKey: String
    private let client: any ShannonAPIClientProtocol

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonAPIClientProtocol = ShannonAPIClient(),
        messages: [ConversationMessage] = []
    ) {
        self.scopeKey = scopeKey
        self.client = client
        self.messages = messages
    }

    public func sendDraft() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        draft = ""
        let message = ConversationMessage(role: .user, text: text, deliveryState: .sending)
        messages.append(message)
        await send(text: text, userMessageID: message.id)
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

    public var canSendDraft: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
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

    private func send(text: String, userMessageID: UUID) async {
        errorMessage = nil
        isSending = true

        do {
            let response = try await client.send(message: text, scopeKey: scopeKey)
            updateDeliveryState(for: userMessageID, to: .sent)
            state = response.state
            let emotion = response.messageEmotion
            messages.append(
                ConversationMessage(
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
            )
        } catch {
            updateDeliveryState(for: userMessageID, to: .failed)
            errorMessage = "Shannonに接続できませんでした。ローカルAPIを確認してください。"
        }
        isSending = false
    }

    private func updateDeliveryState(for id: UUID, to deliveryState: ConversationMessage.DeliveryState) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index] = messages[index].withDeliveryState(deliveryState)
    }
}
