import Foundation

extension ShannonAPIClient {
    public func send(message: String, scopeKey: String, threadId: String? = nil) async throws -> ChatResponseDTO {
        try await send(message: message, scopeKey: scopeKey, threadId: threadId, attachments: [], webSearch: false)
    }

    public func send(
        message: String,
        scopeKey: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO]
    ) async throws -> ChatResponseDTO {
        try await send(
            message: message,
            scopeKey: scopeKey,
            threadId: threadId,
            attachments: attachments,
            webSearch: false
        )
    }

    public func send(
        message: String,
        scopeKey: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool
    ) async throws -> ChatResponseDTO {
        try await send(message: message, scopeKey: scopeKey, threadId: threadId,
                       attachments: attachments, webSearch: webSearch, placeLocation: nil)
    }

    public func send(
        message: String,
        scopeKey: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool,
        placeLocation: ShannonVoiceDeviceLocationDTO? = nil
    ) async throws -> ChatResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ChatRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            message: message,
            threadId: threadId,
            attachments: attachments,
            webSearch: webSearch,
            placeLocation: placeLocation
        ))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
    }

}
