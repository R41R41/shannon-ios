import Foundation

public protocol ShannonAPIClientProtocol: Sendable {
    func send(message: String, scopeKey: String) async throws -> ChatResponseDTO
    func loadConversation(scopeKey: String) async throws -> ConversationHistoryResponseDTO
}

public extension ShannonAPIClientProtocol {
    func loadConversation(scopeKey: String) async throws -> ConversationHistoryResponseDTO {
        throw ShannonAPIError.invalidResponse
    }
}

public enum ShannonAPIError: Error, Equatable {
    case invalidResponse
    case rejected(status: Int)
}

public struct ShannonAPIClient: ShannonAPIClientProtocol, Sendable {
    public let baseURL: URL
    private let apiToken: String?
    private let connectionStore: (any ShannonConnectionStoreProtocol)?
    private let session: URLSession

    public init(
        baseURL: URL = URL(string: "http://127.0.0.1:4317")!,
        apiToken: String? = nil,
        connectionStore: (any ShannonConnectionStoreProtocol)? = nil,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.apiToken = apiToken
        self.connectionStore = connectionStore
        self.session = session
    }

    public func send(message: String, scopeKey: String) async throws -> ChatResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ChatRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            message: message
        ))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
    }

    public func loadConversation(scopeKey: String) async throws -> ConversationHistoryResponseDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/conversation"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }

        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ConversationHistoryResponseDTO.self, from: data)
    }

    private func currentConnection() -> ShannonConnectionCredential? {
        guard let credential = try? connectionStore?.load(),
              credential.baseURL == baseURL,
              credential.expiresAt > Date() else { return nil }
        return credential
    }

    private func authorize(_ request: inout URLRequest, connection: ShannonConnectionCredential?) {
        if let connection {
            request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "authorization")
            return
        }
        guard let apiToken, !apiToken.isEmpty, !apiToken.contains("$(") else { return }
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "authorization")
    }
}
