import Foundation

extension ShannonAPIClient {
    public func send(message: String, scopeKey: String, threadId: String? = nil) async throws -> ChatResponseDTO {
        try await send(message: message, scopeKey: scopeKey, threadId: threadId, attachments: [], webSearch: false)
    }

    public func send(
        message: String,
        scopeKey: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO]
    ) async throws -> ChatResponseDTO {
        try await send(
            message: message,
            scopeKey: scopeKey,
            threadId: threadId,
            attachments: attachments,
            webSearch: false
        )
    }

    public func send(
        message: String,
        scopeKey: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool
    ) async throws -> ChatResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ChatRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            message: message,
            threadId: threadId,
            attachments: attachments,
            webSearch: webSearch
        ))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
    }

    public func transcribeVoice(
        scopeKey: String,
        recording: ShannonVoiceRecording
    ) async throws -> ShannonVoiceTranscriptionDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/transcriptions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 75
        request.setValue(recording.mimeType, forHTTPHeaderField: "content-type")
        request.setValue(String(recording.durationMilliseconds), forHTTPHeaderField: "x-shannon-audio-duration-ms")
        authorize(&request, connection: connection)
        let (data, response) = try await session.upload(for: request, fromFile: recording.fileURL)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonVoiceTranscriptionDTO.self, from: data)
    }

    public func synthesizeGeminiSpeech(scopeKey: String, text: String) async throws -> ShannonGeminiSpeech {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/speech"))
        request.httpMethod = "POST"
        request.timeoutInterval = 75
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(GeminiSpeechRequestDTO(text: text))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        guard http.value(forHTTPHeaderField: "content-type")?.lowercased().hasPrefix("audio/wav") == true,
              !data.isEmpty
        else { throw ShannonAPIError.invalidResponse }
        guard let model = http.value(forHTTPHeaderField: "x-shannon-gemini-model"),
              let voice = http.value(forHTTPHeaderField: "x-shannon-gemini-voice"),
              let duration = http.value(forHTTPHeaderField: "x-shannon-audio-duration-seconds").flatMap(Double.init),
              let cost = http.value(forHTTPHeaderField: "x-shannon-estimated-cost-usd").flatMap(Double.init)
        else { throw ShannonAPIError.invalidResponse }
        return ShannonGeminiSpeech(
            audio: data,
            model: model,
            voice: voice,
            durationSeconds: duration,
            estimatedCostUsd: cost
        )
    }

    public func createRealtimeVoiceCall(
        scopeKey: String,
        threadId: String?,
        offerSDP: String,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonRealtimeVoiceCallDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/realtime/calls"))
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        request.setValue("application/sdp", forHTTPHeaderField: "content-type")
        request.setValue(participantMode.rawValue, forHTTPHeaderField: "x-shannon-voice-participant-mode")
        request.setValue(
            ShannonRemoteVoicePitchPolicy.headerValue(),
            forHTTPHeaderField: "x-shannon-voice-brightness"
        )
        if let threadId, !threadId.isEmpty {
            request.setValue(threadId, forHTTPHeaderField: "x-shannon-thread-id")
        }
        authorize(&request, connection: connection)
        request.httpBody = Data(offerSDP.utf8)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONDecoder().decode(ShannonRealtimeVoiceErrorDTO.self, from: data)
            throw ShannonAPIError.realtimeVoiceRejected(
                status: http.statusCode,
                code: payload?.error
            )
        }
        guard let answerSDP = String(data: data, encoding: .utf8), answerSDP.hasPrefix("v=0") else {
            throw ShannonAPIError.invalidResponse
        }
        let resolvedThreadID = http.value(forHTTPHeaderField: "x-shannon-thread-id") ?? threadId ?? ""
        guard !resolvedThreadID.isEmpty else { throw ShannonAPIError.invalidResponse }
        return ShannonRealtimeVoiceCallDTO(
            answerSDP: answerSDP,
            threadID: resolvedThreadID,
            engine: http.value(forHTTPHeaderField: "x-shannon-voice-engine")
                .flatMap(ShannonVoiceEngine.init(rawValue:)) ?? .realtime,
            model: http.value(forHTTPHeaderField: "x-shannon-realtime-model"),
            callID: http.value(forHTTPHeaderField: "x-shannon-realtime-call-id"),
            dailyRemainingSeconds: http.value(
                forHTTPHeaderField: "x-shannon-realtime-daily-remaining-seconds"
            ).flatMap(Int.init)
        )
    }

    public func performLiveVoiceDelegation(
        scopeKey: String,
        threadId: String?,
        transcript: String,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        try await performLiveVoiceDelegation(
            scopeKey: scopeKey,
            threadId: threadId,
            transcript: transcript,
            participantMode: participantMode,
            deviceContext: nil
        )
    }

    public func performLiveVoiceDelegation(
        scopeKey: String,
        threadId: String?,
        transcript: String,
        participantMode: ShannonVoiceParticipantMode,
        deviceContext: ShannonVoiceDeviceContextDTO?
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/live/delegations"))
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
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        let result = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self, from: data)
        guard !result.threadId.isEmpty, !result.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ShannonAPIError.invalidResponse
        }
        return result
    }

    public func analyzeVoiceCameraSnapshot(
        scopeKey: String,
        threadId: String?,
        jpegData: Data
    ) async throws -> ShannonVoiceVisionResponseDTO {
        guard jpegData.count >= 64, jpegData.count <= 3 * 1_024 * 1_024 else {
            throw ShannonAPIError.invalidResponse
        }
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/vision/snapshots"))
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("image/jpeg", forHTTPHeaderField: "content-type")
        if let threadId, !threadId.isEmpty {
            request.setValue(threadId, forHTTPHeaderField: "x-shannon-thread-id")
        }
        authorize(&request, connection: connection)
        request.httpBody = jpegData
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        let result = try JSONDecoder().decode(ShannonVoiceVisionResponseDTO.self, from: data)
        guard !result.threadId.isEmpty,
              !result.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ShannonAPIError.invalidResponse
        }
        return result
    }

    public func loadVoiceIdentity(scopeKey: String) async throws -> ShannonVoiceIdentityResponseDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/voice/identity"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonVoiceIdentityResponseDTO.self, from: data)
    }

    public func updateVoiceIdentity(
        scopeKey: String,
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?
    ) async throws -> ShannonVoiceIdentityResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/identity"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonVoiceIdentityUpdateRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            mode: mode,
            selectedVoice: selectedVoice
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonVoiceIdentityResponseDTO.self, from: data)
    }

    public func loadRealtimeVoiceAllowance(scopeKey: String) async throws -> ShannonRealtimeVoiceAllowanceDTO {
        try await realtimeVoiceAllowance(scopeKey: scopeKey, method: "GET")
    }

    public func extendRealtimeVoiceAllowance(scopeKey: String) async throws -> ShannonRealtimeVoiceAllowanceDTO {
        try await realtimeVoiceAllowance(scopeKey: scopeKey, method: "POST")
    }

    private func realtimeVoiceAllowance(
        scopeKey: String,
        method: String
    ) async throws -> ShannonRealtimeVoiceAllowanceDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/realtime/allowance"))
        request.httpMethod = method
        authorize(&request, connection: connection)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        return try JSONDecoder().decode(ShannonRealtimeVoiceAllowanceDTO.self, from: data)
    }

    public func loadVoicePreview(scopeKey: String, voice: String) async throws -> Data {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/identity/preview"))
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonVoicePreviewRequestDTO(voice: voice))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode), http.mimeType == "audio/mpeg", !data.isEmpty else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        return data
    }

    public func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/realtime/turns"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonRealtimeVoiceTurnRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId,
            userTranscript: userTranscript,
            shannonTranscript: shannonTranscript
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonRealtimeVoiceTurnResponseDTO.self, from: data)
    }
}

private struct GeminiSpeechRequestDTO: Encodable {
    let text: String
}
