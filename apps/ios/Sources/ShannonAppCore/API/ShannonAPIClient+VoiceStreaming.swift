import Foundation

extension ShannonAPIClient {
    public func performLiveVoiceDelegationStreaming(
        scopeKey: String,
        threadId: String?,
        transcript: String,
        participantMode: ShannonVoiceParticipantMode,
        deviceContext: ShannonVoiceDeviceContextDTO?,
        onSegment: ShannonVoiceSegmentHandler
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/cascade/delegations/stream"))
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonLiveVoiceDelegationRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId,
            transcript: transcript,
            participantMode: participantMode,
            deviceContext: deviceContext
        ))
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        if http.statusCode == 404 || http.statusCode == 405 {
            let legacy = try await performLiveVoiceDelegation(
                scopeKey: scopeKey,
                threadId: threadId,
                transcript: transcript,
                participantMode: participantMode,
                deviceContext: deviceContext
            )
            for segment in ShannonGeminiCascadeSpeech.segments(legacy.reply) {
                await onSegment(segment, legacy.voicePlan)
            }
            return legacy
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        guard http.value(forHTTPHeaderField: "content-type")?.lowercased()
            .hasPrefix("application/x-ndjson") == true else {
            throw ShannonAPIError.invalidResponse
        }

        var completed: ShannonLiveVoiceDelegationResponseDTO?
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard !line.isEmpty else { continue }
            let event = try JSONDecoder().decode(
                ShannonLiveVoiceStreamEventDTO.self,
                from: Data(line.utf8)
            )
            switch event.type {
            case .plan:
                continue
            case .segment:
                guard let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !text.isEmpty else { throw ShannonAPIError.invalidResponse }
                await onSegment(text, event.voicePlan)
            case .completed:
                completed = event.response
            case .error:
                throw ShannonAPIError.rejected(status: event.status ?? 502)
            }
        }
        guard let completed,
              !completed.threadId.isEmpty,
              !completed.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || completed.voicePlan?.shouldRespond == false else {
            throw ShannonAPIError.invalidResponse
        }
        return completed
    }
}
