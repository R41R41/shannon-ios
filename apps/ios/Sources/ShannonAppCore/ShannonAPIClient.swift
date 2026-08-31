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
    private let session: URLSession

    public init(
        baseURL: URL = URL(string: "http://127.0.0.1:4317")!,
        apiToken: String? = nil,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.apiToken = apiToken
        self.session = session
    }

    public func send(message: String, scopeKey: String) async throws -> ChatResponseDTO {
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request)
        request.httpBody = try JSONEncoder().encode(ChatRequestDTO(scopeKey: scopeKey, message: message))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
    }

    public func loadConversation(scopeKey: String) async throws -> ConversationHistoryResponseDTO {
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/conversation"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }

        var request = URLRequest(url: url)
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ConversationHistoryResponseDTO.self, from: data)
    }

    private func authorize(_ request: inout URLRequest) {
        guard let apiToken, !apiToken.isEmpty, !apiToken.contains("$(") else { return }
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "authorization")
    }
}
