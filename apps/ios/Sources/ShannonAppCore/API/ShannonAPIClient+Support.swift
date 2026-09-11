import Foundation

extension ShannonAPIClient {
    func currentConnection() -> ShannonConnectionCredential? {
        guard let credential = try? connectionStore?.load(),
              credential.baseURL == baseURL,
              credential.expiresAt > Date() else { return nil }
        return credential
    }

    func authorize(_ request: inout URLRequest, connection: ShannonConnectionCredential?) {
        if let connection {
            request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "authorization")
            return
        }
        guard let apiToken, !apiToken.isEmpty, !apiToken.contains("$(") else { return }
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "authorization")
    }

    func response<Response: Decodable>(_ type: Response.Type, for request: URLRequest) async throws -> Response {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(type, from: data)
    }
}
