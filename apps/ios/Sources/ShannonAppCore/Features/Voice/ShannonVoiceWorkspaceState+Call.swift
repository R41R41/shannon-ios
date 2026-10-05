import Foundation

/// Starting and ending a voice conversation. The call screen starts one from its sheet; a message
/// Shannon said through the earphones starts one to hear the owner's answer. Both go through here,
/// so a call is the same call however it began, and ends the same way.
extension ShannonVoiceWorkspaceState {
    /// Returns the task that starts the call: it ends once the call is connecting, or has failed to start.
    @discardableResult
    func beginCall(
        mode: ShannonVoiceParticipantMode,
        speechProvider: ShannonSpeechProvider,
        threadID: String?,
        conversationModel: ShannonConversationModel,
        geminiVoiceModel: ShannonGeminiLiveSessionModel
    ) -> Task<Void, Never> {
        // A touch line's id belongs to the one call that listens for its answer, armed after this by that call alone:
        // every other way a call begins (the call screen, a call from her) starts without it.
        ShannonBodyReactionLink.shared.disarm()
#if os(iOS)
        // A call from Shannon that still rings gives way to a conversation the owner starts himself.
        ShannonVoiceCallHost.shared.calls?.appConversationWillBegin()
#endif
        // A call that failed without being ended may still hold a period; it is remembered like any other, and what
        // the owner had typed before a friend joined comes back first.
        restoreOwnerMessage()
        geminiVoiceModel.finishGuestPeriod()
        geminiVoiceModel.stop()
        let context = ShannonVoiceThreadContext(threadID: threadID)
        let requestID = UUID()
        connectionRequestID = requestID
        threadContext = context
        clearPhoto()
        // The previous call stays remembered; its card makes room for the new call.
        callMemory = nil
        // An unshared photo and the owner's failed text in the composer follow a switch, however it happened.
        geminiVoiceModel.participantModeDidChange = { [weak self] mode in self?.participantModeChanged(to: mode) }
        geminiVoiceModel.guestPeriodEnded = { [weak self] period in
            self?.remember(period, threadID: context.threadID, using: conversationModel)
        }
        // Her desktop body is told that he is in a call here, so that it does not take her voice from this phone for his.
        ShannonVoiceCallPresence.shared.configure(
            scopeKey: conversationModel.scopeKey,
            reporter: conversationModel.client as? any ShannonBodyCallReporting,
            mayReport: { [weak conversationModel] in conversationModel.map { !$0.isDesignPreview } ?? false })
        geminiVoiceModel.callReported = { [weak geminiVoiceModel] active in
            if active {
                ShannonVoiceCallPresence.shared.began(audience: geminiVoiceModel?.participantMode == .guest ? .others : .owner)
            } else {
                ShannonVoiceCallPresence.shared.ended()
            }
        }
        geminiVoiceModel.sessionAbandoned = { [weak geminiVoiceModel] in
            ShannonVoiceCallPresence.shared.abandoned(audience: geminiVoiceModel?.participantMode == .guest ? .others : .owner)
        }
        // The one look an owner turn may ask for; however the call began, it is taken the same way.
        geminiVoiceModel.performAppLook = { [conversationModel] ask in await conversationModel.performAppLook(ask) }
        // One minute without a word from either side, while the app is in the background, ends the call as 終了 does.
        geminiVoiceModel.endAfterBackgroundSilence = { [weak self, weak geminiVoiceModel] in
            guard let self, let geminiVoiceModel else { return }
            self.endCall(geminiVoiceModel)
            conversationModel.statusMessage = ShannonVoiceBackgroundCopy.endedAfterSilence
        }
        // Session-owned, not sheet-owned: minimization must not cancel startup.
        return Task {
            guard connectionRequestID == requestID else { return }
            await geminiVoiceModel.start(
                participantMode: mode,
                speechProvider: speechProvider,
                createSession: { participantMode in
                    let session = try await conversationModel.createGeminiLiveSession(
                        participantMode: participantMode, threadID: context.threadID)
                    context.threadID = session.threadId
                    return session
                },
                performDelegation: { request, utterance, participantMode in
                    try await conversationModel.performLiveVoiceDelegationResponse(
                        transcript: request,
                        userUtterance: utterance,
                        participantMode: participantMode,
                        threadID: context.threadID
                    )
                },
                performStreamingDelegation: { request, utterance, participantMode, onSegment in
                    try await conversationModel.performLiveVoiceDelegationStreamingResponse(
                        transcript: request,
                        userUtterance: utterance,
                        participantMode: participantMode,
                        threadID: context.threadID,
                        onSegment: onSegment
                    )
                },
                streamSpeech: { text, style in
                    try await conversationModel.streamSpeech(text, style: style, provider: speechProvider)
                },
                commitTurn: { user, shannon in
                    // Read before the first suspension: the emotion of the reply being saved.
                    try await conversationModel.commitRealtimeVoiceTurn(
                        userTranscript: user,
                        shannonTranscript: shannon,
                        threadID: context.threadID,
                        emotion: geminiVoiceModel.replyEmotion,
                        companionPresent: geminiVoiceModel.companionSuspected
                    )
                },
                handleDelegationResponse: { response in
                    // Called for owner turns only; 「友人も一緒」 turns never reach the owner's thread.
                    if conversationModel.selectedThreadId == response.threadId, let session = response.organizeSession {
                        conversationModel.upsertOrganizeSession(session)
                    }
                    conversationModel.installAgentTaskProposals(
                        response.uiBlocks ?? [],
                        threadID: response.threadId,
                        sourceMessageID: UUID()
                    )
                }
            )
        }
    }

    /// Ends the call as the owner's 終了 does: a running 「友人も一緒」 period is remembered, turns already
    /// answered stay stored, and every open call screen closes.
    func endCall(_ geminiVoiceModel: ShannonGeminiLiveSessionModel) {
        connectionRequestID = nil
        // A touch line that was waiting for his answer belongs to this call only.
        ShannonBodyReactionLink.shared.disarm()
        // A 「友人も一緒」 period that is still running ends with the call and is remembered;
        // the card that replaces the pill says so and offers 「今回は残さない」.
        geminiVoiceModel.finishGuestPeriod()
        geminiVoiceModel.stop()
        threadContext = nil
        clearPhoto()
        // What he had typed before a friend joined comes back with the end of the call.
        restoreOwnerMessage()
        callEndRevision &+= 1
    }
}
