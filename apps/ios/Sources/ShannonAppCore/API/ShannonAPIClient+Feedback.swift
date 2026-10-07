import Foundation

extension ShannonAPIClient: ShannonFeedbackServing {
    private struct FeedbackCommand: Encodable {
        let targetId: String
        let threadId: String
        let expectedRevision: Int
        let operationId: String
        let reaction: ShannonFeedbackReaction?
        enum CodingKeys: String, CodingKey { case targetId, threadId, expectedRevision, operationId, reaction }
        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(targetId, forKey: .targetId)
            try container.encode(threadId, forKey: .threadId)
            try container.encode(expectedRevision, forKey: .expectedRevision)
            try container.encode(operationId, forKey: .operationId)
            try container.encode(reaction, forKey: .reaction)
        }
    }
    private struct FeedbackEnvelope: Decodable { let feedback: ShannonFeedbackDTO }

    public func loadFeedback(scopeKey: String, target: ShannonFeedbackDTO, operationID: String?) async throws -> ShannonFeedbackReadDTO {
        var query = [URLQueryItem(name: "targetId", value: target.targetId), URLQueryItem(name: "threadId", value: target.threadId)]
        if let operationID { query.append(URLQueryItem(name: "operationId", value: operationID)) }
        return try await response(ShannonFeedbackReadDTO.self, for: autonomyGet("/v1/feedback", scopeKey: scopeKey, extra: query))
    }
    public func changeFeedback(scopeKey: String, target: ShannonFeedbackDTO, reaction: ShannonFeedbackReaction?, operationID: String) async throws -> ShannonFeedbackDTO {
        let value = try await response(FeedbackEnvelope.self, for: autonomyPost("/v1/feedback", body: FeedbackCommand(
            targetId: target.targetId, threadId: target.threadId, expectedRevision: target.revision,
            operationId: operationID, reaction: reaction), connection: currentConnection()))
        return value.feedback
    }
}
