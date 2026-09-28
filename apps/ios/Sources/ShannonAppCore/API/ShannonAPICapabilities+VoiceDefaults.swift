import Foundation

public extension ShannonAPIClientProtocol {
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
}
