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
            metadata: ["input_count": String(batch.turns.count)])
        phase = .thinking
        responseTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let coordinator = ShannonGeminiStreamingSpeechCoordinator(
                style: { ShannonGeminiCascadeSpeech.style(for: $0, plan: $1) },
                streamSpeech: streamSpeech,
                consumeSpeech: { [weak self] speech in
                    guard let self else { throw CancellationError() }
                    try await self.consumeResponseSpeech(speech, generation: generation)
                }
            )
            defer { coordinator.cancel() }
            var failureStage = "generation"
            var commit: Task<Bool, Never>?
            do {
                // A completed reply's history write belongs to the session, not
                // playback. Barge-in cannot cancel it or erase context for this turn.
                if let previousCommit { _ = await previousCommit.value }
                try requireCurrentResponse(generation)
                // Authorization remains the last actual utterance, never an LLM reconstruction.
                let utterance = ShannonVoiceUserUtteranceDTO(
                    id: batch.id.uuidString, text: batch.turns[batch.turns.count - 1].text,
                    source: batch.source, rawText: batch.rawText
                )
                let response = try await performStreamingDelegation(batch.text, utterance, mode) {
                    [weak self] segment, plan in
                    guard let self, self.responseGenerationID == generation, !Task.isCancelled else { return }
                    self.latencyMeasurements.recordFirstText(plan: plan)
                    self.shannonTranscript += segment
                    await coordinator.enqueue(segment, plan: plan)
                }
                try requireCurrentResponse(generation)
                try responseDelivery.complete(response, batch: batch, ledger: &pendingTurns)
                shannonTranscript = response.reply
                textSendState = .idle
                latencyMeasurements.recordServerMetrics(response.voiceMetrics)
                handleDelegationResponse?(response)
                ShannonVoiceDiagnostics.shared.record("gemini.response.completed", sessionID: generation.uuidString,
                    metadata: ["acknowledged_input_count": String(batch.turns.count)])
                if mode.allowsTranscriptPersistence, !response.reply.isEmpty, let commitTurn {
                    let task = Task { @MainActor in
                        do {
                            try await commitTurn(batch.rawText, response.reply)
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
                    try await coordinator.finish()
                    try requireCurrentResponse(generation)
                    failureStage = "playback"
                    try await transport?.waitForPlayback()
                    try requireCurrentResponse(generation)
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
                textSendState = .idle
                if responseGenerationID == nil, !pendingTurns.turns.isEmpty, transport != nil {
                    beginResponse()
                }
            } catch is CancellationError {
                ShannonVoiceDiagnostics.shared.record("gemini.response.cancelled", sessionID: generation.uuidString)
                // Only unfinished generation is reused. Completed text stays in history.
                return
            } catch {
                guard responseGenerationID == generation else { return }
                ShannonVoiceDiagnostics.shared.record("gemini.response.failed", sessionID: generation.uuidString,
                    metadata: ["stage": failureStage,
                        "category": ShannonVoiceResponseDelivery.errorCategory(error),
                        "reply_complete": String(responseDelivery.response != nil),
                        "scheduled_audio_ms": String(Int(responseDelivery.scheduledAudioSeconds * 1_000)),
                        "pending_input_count": String(pendingTurns.turns.count)])
                transport?.discardPlayback()
                responseTask = nil
                responseGenerationID = nil
                playbackLevel = 0
                phase = .listening
                errorMessage = responseDelivery.failureMessage
                if responseDelivery.response == nil,
                   let text = batch.turns.last(where: { $0.source == .typed })?.text {
                    textSendState = .failed(text: text, message: "入力を保持しています。次の発話にも引き継ぎます。")
                }
            }
        }
    }

    private func requireCurrentResponse(_ generation: UUID) throws {
        try Task.checkCancellation()
        guard responseGenerationID == generation else { throw CancellationError() }
    }

    private func consumeResponseSpeech(_ speech: ShannonGeminiSpeechStream, generation: UUID) async throws {
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
            }
            latencyMeasurements.recordFirstAudio()
            let duration = try transport?.schedulePCM(chunk) ?? Double(chunk.count) / 48_000
            segmentDuration += duration
            outputAudioSeconds += duration
            playbackLevel = 0.55
            phase = .speaking
            responseDelivery.scheduledAudio(seconds: duration)
        }
        guard segmentDuration > 0 else { throw ShannonAPIError.invalidResponse }
        ttsCostUsd += segmentDuration / 10 * speech.outputUsdPerTenSeconds
        updateCost()
    }
}
#endif
