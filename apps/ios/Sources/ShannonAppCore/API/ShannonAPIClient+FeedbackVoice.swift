import Foundation

public extension ShannonVoiceServing {
    func commitRealtimeVoiceTurn(scopeKey: String, threadId: String?, userTranscript: String, shannonTranscript: String,
        emotion: ShannonVoiceTurnEmotionDTO?, companionPresent: Bool, feedbackRecordID: String?) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        try await commitRealtimeVoiceTurn(scopeKey: scopeKey, threadId: threadId, userTranscript: userTranscript,
            shannonTranscript: shannonTranscript, emotion: emotion, companionPresent: companionPresent)
    }
}

extension ShannonAPIClient {
    public func commitRealtimeVoiceTurn(scopeKey: String, threadId: String?, userTranscript: String, shannonTranscript: String,
        emotion: ShannonVoiceTurnEmotionDTO?, companionPresent: Bool, feedbackRecordID: String?) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/cascade/turns"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonRealtimeVoiceTurnRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId,
            userTranscript: userTranscript,
            shannonTranscript: shannonTranscript,
            emotion: emotion,
            companionPresent: companionPresent ? true : nil,
            feedbackRecordId: companionPresent ? nil : feedbackRecordID,
            utteranceId: ShannonVoiceTurnCorrelation.utteranceID
        ).linkedToReaction())
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonRealtimeVoiceTurnResponseDTO.self, from: data)
    }
}
