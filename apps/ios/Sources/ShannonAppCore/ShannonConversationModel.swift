import Foundation
import Observation

@MainActor
@Observable
public final class ShannonConversationModel {
    public var draft = ""
    public private(set) var messages: [ConversationMessage]
    public private(set) var state: CompanionStateDTO?
    public private(set) var isSending = false
    public private(set) var isLoadingHistory = false
    public private(set) var errorMessage: String?

    private let scopeKey: String
    private let client: any ShannonAPIClientProtocol
    private var didAttemptInitialLoad = false

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

    public func loadConversationIfNeeded() async {
        guard !didAttemptInitialLoad else { return }
        didAttemptInitialLoad = true
        guard messages.isEmpty else { return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }

        do {
            let response = try await client.loadConversation(scopeKey: scopeKey)
            messages = response.messages.compactMap(Self.conversationMessage)
            state = response.state
        } catch {
            errorMessage = "以前の会話を読み込めませんでした。新しい会話はそのまま始められます。"
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
            errorMessage = "シャノンに接続できませんでした。ローカルAPIを確認してください。"
        }
        isSending = false
    }

    private func updateDeliveryState(for id: UUID, to deliveryState: ConversationMessage.DeliveryState) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index] = messages[index].withDeliveryState(deliveryState)
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

    private static func parseDate(_ value: String) -> Date {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let parsed = try? fractional.parse(value) { return parsed }
        if let parsed = try? Date.ISO8601FormatStyle().parse(value) { return parsed }
        return Date()
    }
}
