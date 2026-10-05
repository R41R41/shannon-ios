#if os(iOS)
import Foundation

extension ShannonGeminiLiveSessionModel {
    /// Cancellation owns output only. Only a complete, visible answer handles input.
    func beginResponse() {
        guard let performStreamingDelegation, let streamSpeech else { return }
        guard let batch = pendingTurns.batch() else {
            errorMessage = "一度の入力が長すぎます。内容は保持しています。短く分けて送ってください。"
            return
        }
        responseTask?.cancel()
        transport?.discardPlayback()
        let generation = UUID()
        responseGenerationID = generation
        let mode = participantMode
        latencyMeasurements.startResponse()
        shannonTranscript = ""
        errorMessage = nil
        responseDelivery = ShannonVoiceResponseDelivery()
        let previousCommit = responseCommitTask
        ShannonVoiceDiagnostics.shared.record("gemini.response.started", sessionID: generation.uuidString,
            metadata: ["input_count": String(batch.turns.count), "tts_provider": speechProvider.rawValue])
        phase = .thinking
        responseTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let coordinator = ShannonGeminiStreamingSpeechCoordinator(
                style: { [provider = self.speechProvider] text, plan in
                    provider == .gemini
                        ? ShannonGeminiCascadeSpeech.style(for: text, plan: plan)
                        : ShannonElevenCascadeSpeech.style(for: text, plan: plan)
                },
                streamSpeech: streamSpeech,
                consumeSpeech: { [weak self] speech, text in
                    guard let self else { throw CancellationError() }
                    try await self.consumeResponseSpeech(speech, text: text, generation: generation)
                }
            )
            defer { coordinator.cancel() }
            var failureStage = "generation"
            var commit: Task<Bool, Never>?
            var look: Task<String?, Never>?
            do {
                // A completed reply's history write belongs to the session, not
                // playback. Barge-in cannot cancel it or erase context for this turn.
                if let previousCommit { _ = await previousCommit.value }
                try requireCurrentResponse(generation)
                // Authorization remains the last actual utterance, never an LLM reconstruction.
                // 「友人も一緒」 sends this call's own turns; an owner turn never carries them.
                let utterance = ShannonVoiceUserUtteranceDTO(
                    id: batch.id.uuidString, text: batch.turns[batch.turns.count - 1].text,
                    source: batch.source, rawText: batch.rawText.isEmpty ? nil : batch.rawText,
                    callContext: mode == .guest ? guestCall.requestContext(
                        addressedByName: batch.addressedByName, followsShannonTurn: batch.followsShannonTurn) : nil,
                    companionPresent: companionSuspected ? true : nil
                )
                let localReply = mode == .owner ? batch.localReply : nil
                let onSegment: ShannonVoiceSegmentHandler = {
                    [weak self] segment, plan in
                    guard let self, self.responseGenerationID == generation, !Task.isCancelled else { return }
                    // Provisional with the first sentence, reconciled with later ones: the Eye follows the voice.
                    if let face = plan?.face { self.callFace = face }
                    let firstText = self.latencyMeasurements.firstTextMilliseconds == nil
                    self.latencyMeasurements.recordFirstText(plan: plan)
                    if firstText, let milliseconds = self.latencyMeasurements.firstTextMilliseconds {
                        ShannonVoiceDiagnostics.shared.record("voice.turn.first_text", sessionID: generation.uuidString,
                            metadata: ["provider": self.speechProvider.rawValue,
                                       "response_ms": String(milliseconds)])
                    }
                    self.shannonTranscript += segment
                    // The echo guard and the spoken part learn the sentence when it is played (`consumeResponseSpeech`).
                    self.responseDelivery.spoken.queued(segment, waitingPhrase: plan?.waitingPhrase)
                    await coordinator.enqueue(segment, plan: plan)
                }
                let response = if let localReply {
                    await ShannonVoiceLocalReply.deliver(localReply, onSegment: onSegment)
                } else {
                    try await performStreamingDelegation(batch.text, utterance, mode, onSegment)
                }
                try requireCurrentResponse(generation)
                try responseDelivery.complete(response, batch: batch, ledger: &pendingTurns)
                if let face = response.voicePlan?.face { callFace = face }
                replyEmotion = mode == .owner ? response.voicePlan?.turnEmotion : nil
                shannonTranscript = response.reply
                textSendState = .idle
                latencyMeasurements.recordServerMetrics(response.voiceMetrics)
                if mode == .guest {
                    // Kept for this call only; a later owner turn never sees it.
                    guestCall.record(participant: batch.rawText, shannon: response.reply)
                } else if localReply != nil {
                    guestCall.askedAboutCompanion(now: ProcessInfo.processInfo.systemUptime)
                } else {
                    if response.companionPresent == true { guestCall.companionReported() }
                    handleDelegationResponse?(response)
                }
                // She looks through this app's camera while the reply is spoken (owner turns only).
                look = mode == .owner && localReply == nil ? ShannonAppLookSpeech.begin(response.appLook, with: performAppLook) : nil
                // A reply cut at its length limit is a finished reply ending at a complete sentence.
                ShannonVoiceDiagnostics.shared.record("gemini.response.completed", sessionID: generation.uuidString,
                    metadata: ["acknowledged_input_count": String(batch.turns.count),
                               "truncated": String(response.truncated == true)])
                if mode.allowsTranscriptPersistence, !response.reply.isEmpty, let commitTurn {
                    let task = Task { @MainActor in
                        do {
                            let places = response.uiBlocks?.flatMap { $0.places ?? [] } ?? []
                            try await commitTurn(batch.rawText,
                                ShannonPlaceLinks.appending(places, to: response.reply))
                            return true
                        } catch {
                            ShannonVoiceDiagnostics.shared.record("gemini.response.history.failed",
                                sessionID: generation.uuidString)
                            return false
                        }
                    }
                    commit = task
                    responseCommitTask = task
                }
                if response.voicePlan?.shouldRespond != false {
                    failureStage = "synthesis_stream"
                    // What she saw is her next utterance, spoken behind this reply and known to the echo guard.
                    if let seen = await ShannonAppLookSpeech.spoken(look) { await onSegment(seen, response.voicePlan) }
                    try await coordinator.finish()
                    try requireCurrentResponse(generation)
                    failureStage = "playback"
                    try await transport?.waitForPlayback()
                    try requireCurrentResponse(generation)
                    if let firstAudio = latencyMeasurements.firstAudioMilliseconds,
                       let firstTTSByte = latencyMeasurements.firstTTSByteMilliseconds {
                        let elapsed = Int(max(0, ProcessInfo.processInfo.systemUptime -
                            (latencyMeasurements.responseStartedAt ?? ProcessInfo.processInfo.systemUptime)) * 1_000)
                        ShannonVoiceDiagnostics.shared.record("voice.turn.measurement.completed",
                            sessionID: generation.uuidString,
                            metadata: ["provider": speechProvider.rawValue, "source": batch.source.rawValue,
                                       "first_text_ms": String(latencyMeasurements.firstTextMilliseconds ?? -1),
                                       "first_tts_pcm_ms": String(firstTTSByte),
                                       "first_audio_queued_ms": String(firstAudio),
                                       "playback_complete_ms": String(elapsed)])
                    }
                    ShannonVoiceDiagnostics.shared.record("gemini.response.playback.completed",
                        sessionID: generation.uuidString)
                }
                if let commit {
                    let saved = await commit.value
                    try requireCurrentResponse(generation)
                    if !saved { errorMessage = "返答はできていますが、会話履歴を保存できませんでした。" }
                }
                playbackLevel = 0
                phase = .listening
                responseTask = nil
                responseGenerationID = nil
                markPlaybackEnded()
                textSendState = .idle
                if responseGenerationID == nil, !pendingTurns.turns.isEmpty, transport != nil {
                    beginResponse()
                }
            } catch is CancellationError {
                // He spoke over her, or the call ended: a look that has not captured yet is not taken.
                look?.cancel()
                ShannonVoiceDiagnostics.shared.record("gemini.response.cancelled", sessionID: generation.uuidString)
                // Only unfinished generation is reused. Completed text stays in history.
                return
            } catch {
                guard responseGenerationID == generation else { return }
                let queued = ShannonVoiceResponseDelivery.queuedSpeech(afterFailureAt: failureStage, error: error)
                ShannonVoiceDiagnostics.shared.record("gemini.response.failed", sessionID: generation.uuidString,
                    metadata: ["stage": failureStage,
                        "category": ShannonVoiceResponseDelivery.errorCategory(error),
                        "reply_complete": String(responseDelivery.response != nil),
                        "scheduled_audio_ms": String(Int(responseDelivery.scheduledAudioSeconds * 1_000)),
                        "pending_input_count": String(pendingTurns.turns.count),
                        "queued_speech": queued.rawValue])
                // Her voice already on its way is not cut by a failure; the owner speaking over it
                // still cuts it (`interruptResponse` cancels this task and discards the audio).
                if queued == .finishReceivedSentences { try? await coordinator.finish() }
                if queued != .discard, (try? await transport?.waitForPlayback()) == nil {
                    guard responseGenerationID == generation, !Task.isCancelled else { return }
                    transport?.discardPlayback()
                }
                guard responseGenerationID == generation, !Task.isCancelled else { return }
                if queued == .discard { transport?.discardPlayback() }
                if queued == .finishReceivedSentences { keepSpokenPart(of: batch, mode: mode, generation: generation) }
                responseTask = nil
                responseGenerationID = nil
                markPlaybackEnded()
                playbackLevel = 0
                phase = .listening
                errorMessage = responseDelivery.failureMessage
                if responseDelivery.response == nil, !responseDelivery.keptSpokenPart,
                   let text = batch.turns.last(where: { $0.source == .typed && !$0.isIntroductionCue })?.text {
                    textSendState = .failed(text: text, message: "入力を保持しています。次の発話にも引き継ぎます。")
                }
            }
        }
    }

    /// Generation failed after she had said part of the answer: that part is her reply, marked as
    /// cut off, written like a completed one, and the input it answered is not asked again.
    private func keepSpokenPart(of batch: ShannonPendingVoiceTurns.Batch, mode: ShannonVoiceParticipantMode, generation: UUID) {
        guard let reply = responseDelivery.keepSpokenPart(batch: batch, ledger: &pendingTurns) else { return }
        shannonTranscript = reply
        ShannonVoiceDiagnostics.shared.record("gemini.response.partial_kept", sessionID: generation.uuidString,
            metadata: ["characters": String(reply.count)])
        if mode == .guest {
            guestCall.record(participant: batch.rawText, shannon: reply)
        } else if mode.allowsTranscriptPersistence, let commitTurn {
            responseCommitTask = Task { @MainActor in
                do { try await commitTurn(batch.rawText, reply); return true } catch {
                    ShannonVoiceDiagnostics.shared.record("gemini.response.history.failed", sessionID: generation.uuidString)
                    return false
                }
            }
        }
    }

    private func requireCurrentResponse(_ generation: UUID) throws {
        try Task.checkCancellation()
        guard responseGenerationID == generation else { throw CancellationError() }
    }

    private func consumeResponseSpeech(
        _ speech: ShannonGeminiSpeechStream, text: String, generation: UUID
    ) async throws {
        try requireCurrentResponse(generation)
        voice = speech.voice
        guard speech.sampleRate == 24_000, speech.channels == 1, speech.bitsPerSample == 16 else {
            throw ShannonAPIError.invalidResponse
        }
        var segmentDuration = 0.0
        var receivedFirstChunk = false
        for try await chunk in speech.chunks {
            try requireCurrentResponse(generation)
            guard !chunk.isEmpty, chunk.count % 2 == 0 else { throw ShannonAPIError.invalidResponse }
            if !receivedFirstChunk {
                receivedFirstChunk = true
                latencyMeasurements.recordFirstTTSByte(requestStartedAt: speech.requestStartedAtUptime)
                if let milliseconds = latencyMeasurements.firstTTSByteMilliseconds {
                    ShannonVoiceDiagnostics.shared.record("voice.turn.first_tts_pcm", sessionID: generation.uuidString,
                        metadata: ["provider": speechProvider.rawValue, "request_ms": String(milliseconds)])
                }
            }
            let duration = try transport?.schedulePCM(chunk, onPlayed: segmentDuration == 0
                ? rememberWhenPlayed(text, generation: generation) : nil) ?? Double(chunk.count) / 48_000
            voiceScheduled()
            let firstAudio = latencyMeasurements.firstAudioMilliseconds == nil
            latencyMeasurements.recordFirstAudio()
            if firstAudio, let milliseconds = latencyMeasurements.firstAudioMilliseconds {
                ShannonVoiceDiagnostics.shared.record("voice.turn.first_audio_queued", sessionID: generation.uuidString,
                    metadata: ["provider": speechProvider.rawValue, "response_ms": String(milliseconds),
                               "first_text_ms": String(latencyMeasurements.firstTextMilliseconds ?? -1)])
            }
            segmentDuration += duration
            outputAudioSeconds += duration
            backgroundSilence.speech(at: Date())
            playbackLevel = 0.55
            phase = .speaking
            responseDelivery.scheduledAudio(seconds: duration)
        }
        guard segmentDuration > 0 else { throw ShannonAPIError.invalidResponse }
        if !speech.costEstimateAvailable { ttsCostEstimateAvailable = false }
        ttsCostUsd += segmentDuration / 10 * speech.outputUsdPerTenSeconds
        updateCost()
    }

    /// Diagnostics that used to sit on the call screen now go to Settings › 音声診断.
    func recordSessionSummary() {
        ShannonVoiceDiagnostics.shared.record("gemini.session.summary", metadata: [
            "provider": speechProvider.japaneseName, "model": model, "voice": voice,
            "estimated_cost_usd": ttsCostEstimateAvailable
                ? estimatedCostUsd.formatted(.number.precision(.fractionLength(5))) : "unavailable",
            "interruption_ms": String(interruptionLatencyMilliseconds ?? -1),
            "input_audio_seconds": String(Int(inputAudioSeconds)),
        ])
    }
}
#endif
