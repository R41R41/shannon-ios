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
        errorMessage = nil
        isSending = true
        messages.append(ConversationMessage(role: .user, text: text))

        do {
            let response = try await client.send(message: text, scopeKey: scopeKey)
            state = response.state
            messages.append(ConversationMessage(role: .shannon, text: response.reply))
        } catch {
            errorMessage = "Shannonに接続できませんでした。ローカルAPIを確認してください。"
        }
        isSending = false
    }
}

