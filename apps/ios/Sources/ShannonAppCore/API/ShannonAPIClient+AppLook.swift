import Foundation

extension ShannonAPIClient: ShannonAppLookServing {
    /// `POST /v1/app/looks/{id}`: one frame, or why there is none. The frame leaves the app here and nowhere else.
    public func answerAppLook(id: String, answer: ShannonAppLookAnswerDTO) async throws -> ShannonAppLookAnswerResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/app/looks/\(id)"))
        request.httpMethod = "POST"
        // The server holds the answer while the model looks (up to 20 seconds), and a voice look waits for its turn first.
        request.timeoutInterval = 40
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(connection.map { answer.scoped(to: $0.scopeKey) } ?? answer)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonAppLookAnswerResponseDTO.self, from: data)
    }
}
