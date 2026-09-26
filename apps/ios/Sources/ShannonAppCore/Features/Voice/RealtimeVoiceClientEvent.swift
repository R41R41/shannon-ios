import Foundation

enum ShannonLiveVoiceClientEvent {
    static func realtimeTextTurn(content: String, itemID: String? = nil) throws -> [Data] {
        let normalized = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { throw EncodingError.invalidValue(
            content,
            .init(codingPath: [], debugDescription: "Realtime text input requires content")
        ) }
        let item: [String: Any] = [
            "type": "conversation.item.create",
            "event_id": "shannon-text-\(UUID().uuidString.lowercased())",
            "item": [
                "id": itemID ?? "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
                "type": "message",
                "role": "user",
                "content": [[
                    "type": "input_text",
                    "text": String(normalized.prefix(8_000)),
                ]],
            ],
        ]
        let response: [String: Any] = [
            "type": "response.create",
            "event_id": "shannon-response-\(UUID().uuidString.lowercased())",
        ]
        return try [item, response].map { try JSONSerialization.data(withJSONObject: $0) }
    }

    static func commentary(delegationID: String?, content: String) throws -> Data {
        let normalized = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard delegationID?.isEmpty != true, !normalized.isEmpty else { throw EncodingError.invalidValue(
            content,
            .init(codingPath: [], debugDescription: "Live commentary requires content")
        ) }
        let payload: [String: Any] = [
            "type": "session.commentary.append",
            "event_id": "shannon-result-\(UUID().uuidString.lowercased())",
            "delegation_id": delegationID ?? NSNull(),
            // Stay below the API's 500-token append ceiling for mixed Japanese and URLs.
            "content": String(normalized.prefix(800)),
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }

    static func realtimeFunctionResult(callID: String, content: String) throws -> [Data] {
        let normalizedCallID = callID.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCallID.isEmpty, !normalizedContent.isEmpty else { throw EncodingError.invalidValue(
            content,
            .init(codingPath: [], debugDescription: "Realtime function result requires a call ID and content")
        ) }
        let output: [String: Any] = [
            "type": "conversation.item.create",
            "event_id": "shannon-tool-\(UUID().uuidString.lowercased())",
            "item": [
                "type": "function_call_output",
                "call_id": String(normalizedCallID.prefix(200)),
                "output": String(normalizedContent.prefix(8_000)),
            ],
        ]
        return [try JSONSerialization.data(withJSONObject: output)]
    }

    static func responseControl(_ type: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["type": type,
            "event_id": "shannon-control-\(UUID().uuidString.lowercased())"])
    }
}
