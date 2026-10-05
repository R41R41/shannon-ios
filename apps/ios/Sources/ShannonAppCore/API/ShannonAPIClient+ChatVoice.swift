import Foundation

extension ShannonAPIClient {
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

    public func synthesizeGeminiSpeech(
        scopeKey: String,
        text: String,
        style: String? = nil
    ) async throws -> ShannonGeminiSpeech {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/speech"))
        request.httpMethod = "POST"
        request.timeoutInterval = 75
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(GeminiSpeechRequestDTO(text: text, style: style))
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

    public func streamGeminiSpeech(
        scopeKey: String,
        text: String,
        style: String? = nil
    ) async throws -> ShannonGeminiSpeechStream {
        try await streamSpeech(scopeKey: scopeKey, text: text, style: style, provider: .gemini)
    }

    public func streamSpeech(
        scopeKey: String,
        text: String,
        style: String?,
        provider: ShannonSpeechProvider
    ) async throws -> ShannonGeminiSpeechStream {
        let connection = currentConnection()
        let path = provider == .gemini ? "/v1/voice/gemini/speech/stream" : "/v1/voice/speech/stream"
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 75
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(GeminiSpeechRequestDTO(text: text, style: style, provider: provider))
        let requestStartedAtUptime = ProcessInfo.processInfo.systemUptime
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        if provider == .gemini && (http.statusCode == 404 || http.statusCode == 405) {
            return try await legacyGeminiSpeechStream(scopeKey: scopeKey, text: text, style: style)
        }
        if http.statusCode == 429 {
            // BUSY (the owner's two speech slots are taken) is brief and worth asking again; RATE_LIMITED is not.
            var body = Data()
            for try await byte in bytes where body.count < 2_048 { body.append(byte) }
            if (try? JSONDecoder().decode(ShannonRealtimeVoiceErrorDTO.self, from: body))?.error == "BUSY" {
                throw ShannonSpeechBusy()
            }
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        let modelHeader = provider == .gemini ? "x-shannon-gemini-model" : "x-shannon-voice-model"
        let voiceHeader = provider == .gemini ? "x-shannon-gemini-voice" : "x-shannon-voice-name"
        guard http.value(forHTTPHeaderField: "content-type")?.lowercased().hasPrefix("audio/l16") == true,
              (provider == .gemini || http.value(forHTTPHeaderField: "x-shannon-voice-engine") == provider.rawValue),
              let model = http.value(forHTTPHeaderField: modelHeader),
              let voice = http.value(forHTTPHeaderField: voiceHeader),
              let sampleRate = http.value(forHTTPHeaderField: "x-shannon-audio-sample-rate").flatMap(Int.init),
              let channels = http.value(forHTTPHeaderField: "x-shannon-audio-channels").flatMap(Int.init),
              let bits = http.value(forHTTPHeaderField: "x-shannon-audio-bits-per-sample").flatMap(Int.init),
              let costRate = http.value(forHTTPHeaderField: "x-shannon-output-usd-per-10-seconds").flatMap(Double.init),
              sampleRate == 24_000,
              channels == 1,
              bits == 16,
              costRate >= 0
        else { throw ShannonAPIError.invalidResponse }
        return ShannonGeminiSpeechStream(
            model: model,
            voice: voice,
            sampleRate: sampleRate,
            channels: channels,
            bitsPerSample: bits,
            outputUsdPerTenSeconds: costRate,
            costEstimateAvailable: http.value(forHTTPHeaderField: "x-shannon-cost-estimate-available") != "false",
            requestStartedAtUptime: requestStartedAtUptime,
            chunks: Self.bufferedGeminiPCM(bytes)
        )
    }

    private func legacyGeminiSpeechStream(
        scopeKey: String,
        text: String,
        style: String?
    ) async throws -> ShannonGeminiSpeechStream {
        let speech = try await synthesizeGeminiSpeech(scopeKey: scopeKey, text: text, style: style)
        let wav = try ShannonGeminiWAV.parse(speech.audio)
        let costRate = speech.durationSeconds > 0
            ? speech.estimatedCostUsd / speech.durationSeconds * 10
            : 0
        return ShannonGeminiSpeechStream(
            model: speech.model,
            voice: speech.voice,
            sampleRate: wav.sampleRate,
            channels: wav.channels,
            bitsPerSample: wav.bitsPerSample,
            outputUsdPerTenSeconds: costRate,
            chunks: AsyncThrowingStream { continuation in
                continuation.yield(wav.pcm)
                continuation.finish()
            }
        )
    }

    private static func bufferedGeminiPCM(
        _ bytes: URLSession.AsyncBytes
    ) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var buffer = Data()
                buffer.reserveCapacity(4_800)
                var totalBytes = 0
                do {
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        buffer.append(byte)
                        totalBytes += 1
                        guard totalBytes <= 8 * 1_024 * 1_024 else {
                            throw URLError(.dataLengthExceedsMaximum)
                        }
                        if buffer.count >= 4_800 {
                            continuation.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    guard totalBytes > 0, buffer.count % 2 == 0 else {
                        throw ShannonAPIError.invalidResponse
                    }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    public func createGeminiLiveSession(
        scopeKey: String,
        threadId: String?
    ) async throws -> ShannonGeminiLiveSessionDTO {
        try await createGeminiLiveSession(
            scopeKey: scopeKey,
            threadId: threadId,
            participantMode: .owner
        )
    }

    public func createGeminiLiveSession(
        scopeKey: String,
        threadId: String?,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonGeminiLiveSessionDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/cascade/sessions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(GeminiLiveSessionRequestDTO(
            threadId: threadId,
            participantMode: participantMode
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        let result = try JSONDecoder().decode(ShannonGeminiLiveSessionDTO.self, from: data)
        guard result.transcriptionProvider == "openai", result.token.hasPrefix("ek_"),
              ShannonOpenAITranscriptionProtocol.acceptedModels.contains(result.model),
              !result.voice.isEmpty,
              !result.threadId.isEmpty,
              !result.instructions.isEmpty else { throw ShannonAPIError.invalidResponse }
        return result
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
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/gemini/cascade/delegations"))
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
        ).linkedToReaction())
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        let result = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self, from: data)
        guard !result.threadId.isEmpty,
              !result.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || result.voicePlan?.shouldRespond == false else {
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
        try await commitRealtimeVoiceTurn(
            scopeKey: scopeKey, threadId: threadId,
            userTranscript: userTranscript, shannonTranscript: shannonTranscript, emotion: nil
        )
    }

    public func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String,
        emotion: ShannonVoiceTurnEmotionDTO?
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        try await commitRealtimeVoiceTurn(
            scopeKey: scopeKey, threadId: threadId, userTranscript: userTranscript,
            shannonTranscript: shannonTranscript, emotion: emotion, companionPresent: false
        )
    }

    public func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String,
        emotion: ShannonVoiceTurnEmotionDTO?,
        companionPresent: Bool
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
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
            companionPresent: companionPresent ? true : nil
        ).linkedToReaction())
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonRealtimeVoiceTurnResponseDTO.self, from: data)
    }
}

private struct GeminiSpeechRequestDTO: Encodable {
    let text: String
    let style: String?
    var provider: ShannonSpeechProvider? = nil
}

private struct GeminiLiveSessionRequestDTO: Encodable {
    let threadId: String?
    let participantMode: ShannonVoiceParticipantMode
    var transcriptionProvider = "openai"
}
