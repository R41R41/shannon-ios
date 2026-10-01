import Foundation

public extension ShannonAPIClientProtocol {
    func streamSpeech(
        scopeKey: String,
        text: String,
        style: String?,
        provider: ShannonSpeechProvider
    ) async throws -> ShannonGeminiSpeechStream {
        guard provider == .gemini else { throw ShannonAPIError.invalidResponse }
        return try await streamGeminiSpeech(scopeKey: scopeKey, text: text, style: style)
    }

    func transcribeVoice(
        scopeKey: String,
        recording: ShannonVoiceRecording
    ) async throws -> ShannonVoiceTranscriptionDTO {
        throw ShannonAPIError.invalidResponse
    }

    func synthesizeGeminiSpeech(
        scopeKey: String,
        text: String,
        style: String? = nil
    ) async throws -> ShannonGeminiSpeech {
        throw ShannonAPIError.invalidResponse
    }

    func streamGeminiSpeech(
        scopeKey: String,
        text: String,
        style: String? = nil
    ) async throws -> ShannonGeminiSpeechStream {
        let speech = try await synthesizeGeminiSpeech(scopeKey: scopeKey, text: text, style: style)
        let wav = try ShannonGeminiWAV.parse(speech.audio)
        let rate = speech.durationSeconds > 0
            ? speech.estimatedCostUsd / speech.durationSeconds * 10
            : 0
        return ShannonGeminiSpeechStream(
            model: speech.model,
            voice: speech.voice,
            sampleRate: wav.sampleRate,
            channels: wav.channels,
            bitsPerSample: wav.bitsPerSample,
            outputUsdPerTenSeconds: rate,
            chunks: AsyncThrowingStream { continuation in
                continuation.yield(wav.pcm)
                continuation.finish()
            }
        )
    }

    func createGeminiLiveSession(
        scopeKey: String,
        threadId: String?
    ) async throws -> ShannonGeminiLiveSessionDTO {
        throw ShannonAPIError.invalidResponse
    }

    func createGeminiLiveSession(
        scopeKey: String,
        threadId: String?,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonGeminiLiveSessionDTO {
        try await createGeminiLiveSession(scopeKey: scopeKey, threadId: threadId)
    }

    func createRealtimeVoiceCall(
        scopeKey: String,
        threadId: String?,
        offerSDP: String,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonRealtimeVoiceCallDTO {
        throw ShannonAPIError.invalidResponse
    }

    func performLiveVoiceDelegation(
        scopeKey: String,
        threadId: String?,
        transcript: String,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func performLiveVoiceDelegation(
        scopeKey: String,
        threadId: String?,
        transcript: String,
        participantMode: ShannonVoiceParticipantMode,
        deviceContext: ShannonVoiceDeviceContextDTO?
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        try await performLiveVoiceDelegation(
            scopeKey: scopeKey,
            threadId: threadId,
            transcript: transcript,
            participantMode: participantMode
        )
    }

    func performLiveVoiceDelegationStreaming(
        scopeKey: String,
        threadId: String?,
        transcript: String,
        participantMode: ShannonVoiceParticipantMode,
        deviceContext: ShannonVoiceDeviceContextDTO?,
        onSegment: ShannonVoiceSegmentHandler
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let response = try await performLiveVoiceDelegation(
            scopeKey: scopeKey,
            threadId: threadId,
            transcript: transcript,
            participantMode: participantMode,
            deviceContext: deviceContext
        )
        for segment in ShannonGeminiCascadeSpeech.segments(response.reply) {
            await onSegment(segment, response.voicePlan)
        }
        return response
    }

    func analyzeVoiceCameraSnapshot(
        scopeKey: String,
        threadId: String?,
        jpegData: Data
    ) async throws -> ShannonVoiceVisionResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadVoiceIdentity(scopeKey: String) async throws -> ShannonVoiceIdentityResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func updateVoiceIdentity(
        scopeKey: String,
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?
    ) async throws -> ShannonVoiceIdentityResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadVoicePreview(scopeKey: String, voice: String) async throws -> Data {
        throw ShannonAPIError.invalidResponse
    }

    func loadRealtimeVoiceAllowance(scopeKey: String) async throws -> ShannonRealtimeVoiceAllowanceDTO {
        throw ShannonAPIError.invalidResponse
    }

    func extendRealtimeVoiceAllowance(scopeKey: String) async throws -> ShannonRealtimeVoiceAllowanceDTO {
        throw ShannonAPIError.invalidResponse
    }

    func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    /// A client that does not carry the emotion still stores the turn.
    func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String,
        emotion: ShannonVoiceTurnEmotionDTO?
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        try await commitRealtimeVoiceTurn(
            scopeKey: scopeKey, threadId: threadId,
            userTranscript: userTranscript, shannonTranscript: shannonTranscript
        )
    }

    /// A client that does not carry the flag still stores the turn as the owner's.
    func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String,
        emotion: ShannonVoiceTurnEmotionDTO?,
        companionPresent: Bool
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        try await commitRealtimeVoiceTurn(
            scopeKey: scopeKey, threadId: threadId,
            userTranscript: userTranscript, shannonTranscript: shannonTranscript, emotion: emotion
        )
    }

    func rememberVoiceCall(
        scopeKey: String,
        callId: String,
        threadId: String?,
        turns: [ShannonVoiceCallContextTurnDTO]
    ) async throws -> ShannonRememberedVoiceCallDTO {
        throw ShannonAPIError.invalidResponse
    }

    func discardVoiceCall(scopeKey: String, callId: String) async throws {
        throw ShannonAPIError.invalidResponse
    }
}
