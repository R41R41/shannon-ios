import Foundation
import Observation

extension ShannonConversationModel {
    public func sendDraft(
        attachments: [ShannonChatAttachmentDTO] = [],
        webSearch: Bool = false,
        photoJPEGData: Data? = nil
    ) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty || photoJPEGData != nil), !isSending else { return }
        draft = ""
        let messageText = Self.messageText(text: text, attachments: attachments, includesPhoto: photoJPEGData != nil)
        let message = ConversationMessage(role: .user, text: messageText, deliveryState: .sending)
        messages.append(message)
        if !attachments.isEmpty {
            pendingAttachmentsByMessageID[message.id] = attachments
        }
        if webSearch {
            pendingWebSearchMessageIDs.insert(message.id)
        }
        if let photoJPEGData {
            pendingPhotoByMessageID[message.id] = photoJPEGData
        }
        await send(
            text: messageText,
            userMessageID: message.id,
            attachments: attachments,
            webSearch: webSearch,
            photoJPEGData: photoJPEGData
        )
    }

    public func transcribeVoice(_ recording: ShannonVoiceRecording) async throws -> String {
        defer { try? FileManager.default.removeItem(at: recording.fileURL) }
        let result = try await client.transcribeVoice(scopeKey: scopeKey, recording: recording)
        let value = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw ShannonAPIError.invalidResponse }
        return value
    }

    public func sendGeminiVoiceTurn(_ transcript: String) async throws -> String {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { throw ShannonAPIError.invalidResponse }
        let message = ConversationMessage(role: .user, text: text, deliveryState: .sending)
        messages.append(message)
        guard let reply = await send(text: text, userMessageID: message.id) else {
            throw ShannonAPIError.invalidResponse
        }
        return reply
    }

    public func synthesizeGeminiSpeech(_ text: String, style: String? = nil) async throws -> ShannonGeminiSpeech {
        try await client.synthesizeGeminiSpeech(scopeKey: scopeKey, text: text, style: style)
    }

    public func streamGeminiSpeech(_ text: String, style: String? = nil) async throws -> ShannonGeminiSpeechStream {
        try await client.streamGeminiSpeech(scopeKey: scopeKey, text: text, style: style)
    }

    public func streamSpeech(
        _ text: String,
        style: String?,
        provider: ShannonSpeechProvider
    ) async throws -> ShannonGeminiSpeechStream {
        try await client.streamSpeech(scopeKey: scopeKey, text: text, style: style, provider: provider)
    }

    public func createGeminiLiveSession(
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonGeminiLiveSessionDTO {
        let session = try await client.createGeminiLiveSession(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            participantMode: participantMode
        )
        if participantMode == .owner { selectedThreadId = session.threadId }
        return session
    }

    public func createRealtimeVoiceCall(
        offerSDP: String,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonRealtimeVoiceCallDTO {
        let call = try await client.createRealtimeVoiceCall(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            offerSDP: offerSDP,
            participantMode: participantMode
        )
        if participantMode == .owner { selectedThreadId = call.threadID }
        return call
    }

    public func performLiveVoiceDelegation(
        transcript: String,
        userUtterance: ShannonVoiceUserUtteranceDTO? = nil,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> String {
        try await performLiveVoiceDelegationResponse(
            transcript: transcript,
            userUtterance: userUtterance,
            participantMode: participantMode
        ).reply
    }

    public func performLiveVoiceDelegationResponse(
        transcript: String,
        userUtterance: ShannonVoiceUserUtteranceDTO? = nil,
        participantMode: ShannonVoiceParticipantMode
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let requestedLocation = ShannonVoiceLocationIntent.needsCurrentLocation(transcript)
#if os(iOS)
        let location = requestedLocation
            ? await ShannonVoiceLocationProvider.shared.currentLocation()
            : nil
#else
        let location: ShannonVoiceDeviceLocationDTO? = nil
#endif
        let result = try await client.performLiveVoiceDelegation(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            transcript: transcript,
            participantMode: participantMode,
            deviceContext: ShannonVoiceDeviceContextDTO(
                timeZoneIdentifier: TimeZone.current.identifier,
                requestedLocation: requestedLocation,
                location: location,
                userUtterance: userUtterance
            )
        )
        if participantMode == .owner {
            selectedThreadId = result.threadId
            if let session = result.organizeSession { upsertOrganizeSession(session) }
        }
        return result
    }

    public func performLiveVoiceDelegationStreamingResponse(
        transcript: String,
        userUtterance: ShannonVoiceUserUtteranceDTO? = nil,
        participantMode: ShannonVoiceParticipantMode,
        onSegment: ShannonVoiceSegmentHandler
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let requestedLocation = ShannonVoiceLocationIntent.needsCurrentLocation(transcript)
#if os(iOS)
        let location = requestedLocation
            ? await ShannonVoiceLocationProvider.shared.currentLocation()
            : nil
#else
        let location: ShannonVoiceDeviceLocationDTO? = nil
#endif
        let result = try await client.performLiveVoiceDelegationStreaming(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            transcript: transcript,
            participantMode: participantMode,
            deviceContext: ShannonVoiceDeviceContextDTO(
                timeZoneIdentifier: TimeZone.current.identifier,
                requestedLocation: requestedLocation,
                location: location,
                userUtterance: userUtterance
            ),
            onSegment: onSegment
        )
        if participantMode == .owner {
            selectedThreadId = result.threadId
            if let session = result.organizeSession { upsertOrganizeSession(session) }
        }
        return result
    }

    public func analyzeVoiceCameraSnapshot(jpegData: Data) async throws -> String {
        let result = try await client.analyzeVoiceCameraSnapshot(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            jpegData: jpegData
        )
        selectedThreadId = result.threadId
        return result.description
    }

    public func commitRealtimeVoiceTurn(
        userTranscript: String,
        shannonTranscript: String
    ) async throws {
        let userText = userTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let shannonText = shannonTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userText.isEmpty, !shannonText.isEmpty else { throw ShannonAPIError.invalidResponse }
        let response = try await client.commitRealtimeVoiceTurn(
            scopeKey: scopeKey,
            threadId: selectedThreadId,
            userTranscript: userText,
            shannonTranscript: shannonText
        )
        selectedThreadId = response.threadId
        state = response.state
        let emotion = response.messageEmotion
        messages.append(ConversationMessage(role: .user, text: userText))
        messages.append(ConversationMessage(
            role: .shannon,
            text: shannonText,
            emotionSnapshot: ConversationMessage.EmotionSnapshot(
                valence: emotion.valence,
                arousal: emotion.arousal,
                openness: emotion.openness,
                expression: emotion.expression,
                stateVersion: response.state.version
            )
        ))
        cacheCurrentHistory()
        await loadThreads(force: true)
    }
}
