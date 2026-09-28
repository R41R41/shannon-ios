#if os(iOS)
import Foundation

extension ShannonGeminiLiveSessionModel {
    /// Cancellation owns output only. The ledger owns inputs until a response is heard.
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
        responsePlaybackDeadline = ProcessInfo.processInfo.systemUptime
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
            do {
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
                if response.voicePlan?.shouldRespond != false {
                    guard !response.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        throw ShannonAPIError.invalidResponse
                    }
                    try await coordinator.finish()
                    try requireCurrentResponse(generation)
                    let remaining = max(0, responsePlaybackDeadline - ProcessInfo.processInfo.systemUptime)
                    try await Task.sleep(for: .seconds(remaining))
                    try requireCurrentResponse(generation)
                }
                latencyMeasurements.recordServerMetrics(response.voiceMetrics)
                shannonTranscript = response.reply
                pendingTurns.acknowledge(batch)
                playbackLevel = 0
                phase = .listening
                responseTask = nil
                responseGenerationID = nil
                textSendState = .idle
                handleDelegationResponse?(response)
                if mode.allowsTranscriptPersistence, !response.reply.isEmpty, let commitTurn {
                    do {
                        try await commitTurn(batch.rawText, response.reply)
                    } catch {
                        // Do not overwrite a newer response's state after this await.
                        if responseGenerationID == nil {
                            errorMessage = "返答は完了しましたが、会話履歴を保存できませんでした。"
                        }
                    }
                }
                if responseGenerationID == nil, !pendingTurns.turns.isEmpty, transport != nil {
                    beginResponse()
                }
            } catch is CancellationError {
                // A replacement response or reconnect will reuse the unacknowledged inputs.
                return
            } catch {
                guard responseGenerationID == generation else { return }
                transport?.discardPlayback()
                responseTask = nil
                responseGenerationID = nil
                playbackLevel = 0
                phase = .listening
                errorMessage = "返答を作れませんでした。入力は保持しています。続けて話すか再送してください。"
                if let text = batch.turns.last(where: { $0.source == .typed })?.text {
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
            responsePlaybackDeadline = max(responsePlaybackDeadline, ProcessInfo.processInfo.systemUptime) + duration
        }
        guard segmentDuration > 0 else { throw ShannonAPIError.invalidResponse }
        ttsCostUsd += segmentDuration / 10 * speech.outputUsdPerTenSeconds
        updateCost()
    }
}
#endif
