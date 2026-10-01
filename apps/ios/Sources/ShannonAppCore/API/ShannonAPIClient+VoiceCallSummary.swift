import Foundation

extension ShannonAPIClient {
    /// Asks the server to keep a short summary of a 「友人も一緒」 call. Sent only on the owner's yes.
    public func saveVoiceCallSummary(
        scopeKey: String,
        threadId: String?,
        turns: [ShannonVoiceCallContextTurnDTO]
    ) async throws -> ShannonVoiceCallSummaryResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/cascade/summaries"))
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonVoiceCallSummaryRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId,
            turns: turns
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        let result = try JSONDecoder().decode(ShannonVoiceCallSummaryResponseDTO.self, from: data)
        guard !result.threadId.isEmpty, ShannonVoiceCallSummaryNote.isNote(result.summary) else {
            throw ShannonAPIError.invalidResponse
        }
        return result
    }
}
