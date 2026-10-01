import Foundation

extension ShannonAPIClient {
    public func loadConversation(scopeKey: String, threadId: String? = nil) async throws -> ConversationHistoryResponseDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/conversation"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
        ]
        if let threadId, !threadId.isEmpty {
            components?.queryItems?.append(URLQueryItem(name: "threadId", value: threadId))
        }
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }

        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ConversationHistoryResponseDTO.self, from: data)
    }

    public func loadConversationCaptures(scopeKey: String, threadId: String) async throws -> ShannonConversationCapturesDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/conversation/captures"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
            URLQueryItem(name: "threadId", value: threadId),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonConversationCapturesDTO.self, for: request)
    }

    public func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/threads"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }

        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ThreadListResponseDTO.self, for: request)
    }

    public func createThread(scopeKey: String, title: String?) async throws -> String {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/threads"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ThreadCreateRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            title: title
        ))
        let responseBody: ThreadCreateResponseDTO = try await response(ThreadCreateResponseDTO.self, for: request)
        return responseBody.threadId
    }

    public func archiveThread(scopeKey: String, threadId: String) async throws {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/threads/archive"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ThreadArchiveRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId
        ))
        let result: ThreadArchiveResponseDTO = try await response(ThreadArchiveResponseDTO.self, for: request)
        guard result.archived else { throw ShannonAPIError.invalidResponse }
    }

    public func renameThread(scopeKey: String, threadId: String, title: String) async throws {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/threads/title"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ThreadRenameRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId,
            title: title
        ))
        let result: ThreadRenameResponseDTO = try await response(ThreadRenameResponseDTO.self, for: request)
        guard result.renamed else { throw ShannonAPIError.invalidResponse }
    }
}
