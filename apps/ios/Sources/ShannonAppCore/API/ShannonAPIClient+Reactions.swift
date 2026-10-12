import Foundation

extension ShannonAPIClient: ShannonReactionServing {
    private struct ReactionCommand: Encodable {
        let threadId: String
        let messageId: String
        let emoji: String
        let on: Bool
    }
    private struct ReactionEnvelope: Decodable { let reaction: ShannonMessageReactionDTO }

    /// `POST /v1/reactions` (rich chat): the owner's scope, while he alone can see the screen; others present is a 403.
    public func changeReaction(scopeKey: String, threadId: String, messageId: String, emoji: String, on: Bool) async throws -> ShannonMessageReactionDTO {
        let value = try await response(ReactionEnvelope.self, for: autonomyPost("/v1/reactions", body: ReactionCommand(
            threadId: threadId, messageId: messageId, emoji: emoji, on: on), connection: currentConnection()))
        return value.reaction
    }
}
