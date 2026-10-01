import Foundation

extension ShannonAPIClient {
    /// Hands one ended 「友人も一緒」 period to the server to be remembered.
    public func rememberVoiceCall(
        scopeKey: String,
        callId: String,
        threadId: String?,
        turns: [ShannonVoiceCallContextTurnDTO]
    ) async throws -> ShannonRememberedVoiceCallDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/cascade/calls"))
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonVoiceRememberCallRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey, callId: callId, threadId: threadId, turns: turns))
        let result = try await response(ShannonRememberedVoiceCallDTO.self, for: request)
        guard result.callId == callId, result.status == "remembered" else { throw ShannonAPIError.invalidResponse }
        return result
    }

    /// 「今回は残さない」 for one period.
    public func discardVoiceCall(scopeKey: String, callId: String) async throws {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/cascade/calls/discard"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonVoiceDiscardCallRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey, callId: callId))
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
    }

    public func loadPeopleMemory(scopeKey: String) async throws -> ShannonPeopleMemoryDTO {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: "/v1/people/memory"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonPeopleMemoryDTO.self, for: request)
    }

    public func mutatePeopleMemory(scopeKey: String, change: ShannonPeopleMemoryChange) async throws -> ShannonPeopleMemoryDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/people/memory/action"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(change.request(scopeKey: connection?.scopeKey ?? scopeKey))
        return try await response(ShannonPeopleMemoryDTO.self, for: request)
    }
}
