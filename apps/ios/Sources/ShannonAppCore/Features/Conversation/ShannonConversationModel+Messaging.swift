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
        try await createGeminiLiveSession(participantMode: participantMode, threadID: selectedThreadId)
    }

    public func createGeminiLiveSession(
        participantMode: ShannonVoiceParticipantMode,
        threadID: String?
    ) async throws -> ShannonGeminiLiveSessionDTO {
        let requestedThreadID = threadID
        let session = try await client.createGeminiLiveSession(
            scopeKey: scopeKey,
            threadId: requestedThreadID,
            participantMode: participantMode
        )
        if participantMode == .owner, selectedThreadId == requestedThreadID {
            selectedThreadId = session.threadId
        }
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
        participantMode: ShannonVoiceParticipantMode,
        threadID: String? = nil
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let requestedThreadID = threadID ?? selectedThreadId
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
            threadId: requestedThreadID,
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
            if selectedThreadId == requestedThreadID { selectedThreadId = result.threadId }
            if selectedThreadId == result.threadId, let session = result.organizeSession { upsertOrganizeSession(session) }
        }
        return result
    }

    public func performLiveVoiceDelegationStreamingResponse(
        transcript: String,
        userUtterance: ShannonVoiceUserUtteranceDTO? = nil,
        participantMode: ShannonVoiceParticipantMode,
        threadID: String? = nil,
        onSegment: ShannonVoiceSegmentHandler
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let requestedThreadID = threadID ?? selectedThreadId
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
            threadId: requestedThreadID,
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
            if selectedThreadId == requestedThreadID { selectedThreadId = result.threadId }
            if selectedThreadId == result.threadId, let session = result.organizeSession { upsertOrganizeSession(session) }
        }
        return result
    }

    public func analyzeVoiceCameraSnapshot(jpegData: Data, threadID: String? = nil) async throws -> String {
        let requestedThreadID = threadID ?? selectedThreadId
        let result = try await client.analyzeVoiceCameraSnapshot(
            scopeKey: scopeKey,
            threadId: requestedThreadID,
            jpegData: jpegData
        )
        if selectedThreadId == requestedThreadID { selectedThreadId = result.threadId }
        return result.description
    }

    public func commitRealtimeVoiceTurn(
        userTranscript: String,
        shannonTranscript: String,
        threadID: String? = nil
    ) async throws {
        let requestedThreadID = threadID ?? selectedThreadId
        let userText = userTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let shannonText = shannonTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userText.isEmpty, !shannonText.isEmpty else { throw ShannonAPIError.invalidResponse }
        let response = try await client.commitRealtimeVoiceTurn(
            scopeKey: scopeKey,
            threadId: requestedThreadID,
            userTranscript: userText,
            shannonTranscript: shannonText
        )
        state = response.state
        let emotion = response.messageEmotion
        let pair = [ConversationMessage(role: .user, text: userText), ConversationMessage(
            role: .shannon,
            text: shannonText,
            emotionSnapshot: ConversationMessage.EmotionSnapshot(
                valence: emotion.valence,
                arousal: emotion.arousal,
                openness: emotion.openness,
                expression: emotion.expression,
                stateVersion: response.state.version
            )
        )]
        if selectedThreadId == requestedThreadID || selectedThreadId == response.threadId {
            selectedThreadId = response.threadId
            messages.append(contentsOf: pair)
            cacheCurrentHistory()
        } else {
            // A call can finish a turn while the user is browsing another thread.
            // Cache only for that call's thread; never append to the visible history.
            cachedHistories[response.threadId, default: []].append(
                contentsOf: pair.map(ShannonConversationCache.CachedMessage.init)
            )
        }
        persistDisplayCache()
        await loadThreads(force: true)
    }
}
