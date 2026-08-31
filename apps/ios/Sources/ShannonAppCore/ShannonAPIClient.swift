import Foundation

public protocol ShannonAPIClientProtocol: Sendable {
    func send(message: String, scopeKey: String) async throws -> ChatResponseDTO
}

public enum ShannonAPIError: Error, Equatable {
    case invalidResponse
    case rejected(status: Int)
}

public struct ShannonAPIClient: ShannonAPIClientProtocol, Sendable {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL = URL(string: "http://127.0.0.1:4317")!, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func send(message: String, scopeKey: String) async throws -> ChatResponseDTO {
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(ChatRequestDTO(scopeKey: scopeKey, message: message))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
    }
}

