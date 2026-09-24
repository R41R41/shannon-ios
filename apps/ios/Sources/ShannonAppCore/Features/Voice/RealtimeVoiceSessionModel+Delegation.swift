import Foundation

#if os(iOS) && canImport(WebRTC)
@MainActor
extension ShannonRealtimeVoiceSessionModel {
    func beginLiveDelegation(id: String, generation: Int) {
        guard engine == .live,
              liveDelegationTasks[id] == nil,
              let performLiveDelegation,
              let transport else { return }
        let transcript = transcriptState.delegationTranscript
        guard !transcript.isEmpty else {
            diagnostics.record("live.delegation.missing_transcript")
            return
        }
        diagnostics.record("live.delegation.started")
        let mode = participantMode
        let epoch = turnCoordinator.epoch
        let utterance = ShannonVoiceUserUtteranceDTO(id: turnCoordinator.userItemID, text: transcript)
        liveDelegationTasks[id] = Task { @MainActor [weak self] in
            defer { self?.liveDelegationTasks[id] = nil }
            do {
                let reply = try await performLiveDelegation(transcript, utterance, mode)
                guard !Task.isCancelled, self?.sessionGeneration == generation, self?.turnCoordinator.epoch == epoch else { return }
                try transport.send(ShannonLiveVoiceClientEvent.commentary(
                    delegationID: id,
                    content: reply
                ))
                self?.diagnostics.record("live.delegation.returned")
            } catch {
                guard !Task.isCancelled, self?.sessionGeneration == generation, self?.turnCoordinator.epoch == epoch else { return }
                self?.diagnostics.record(
                    "live.delegation.failed",
                    metadata: self?.safeErrorMetadata(error) ?? [:]
                )
                self?.errorMessage = "調べものの結果を音声へ戻せませんでした。会話はそのまま続けられます。"
                if let fallback = try? ShannonLiveVoiceClientEvent.commentary(
                    delegationID: id,
                    content: "調べものを完了できませんでした。必要なら、もう一度聞いてください。"
                ) {
                    try? transport.send(fallback)
                }
            }
        }
    }

    func beginRealtimeFunctionCall(callID: String, request: String, generation: Int, responseID: String? = nil) {
        guard engine == .realtime,
              liveDelegationTasks[callID] == nil,
              let performLiveDelegation,
              let transport,
              let epoch = turnCoordinator.registerCall(callID, responseID: responseID) else { return }
        diagnostics.record("realtime.function.started", metadata: ["name": "consult_shannon_backend"])
        let mode = participantMode
        let utterance = turnCoordinator.userText.isEmpty ? nil : ShannonVoiceUserUtteranceDTO(
            id: turnCoordinator.userItemID, text: turnCoordinator.userText)
        liveDelegationTasks[callID] = Task { @MainActor [weak self] in
            defer { self?.liveDelegationTasks[callID] = nil }
            do {
                let reply = try await performLiveDelegation(request, utterance, mode)
                guard !Task.isCancelled, let self, self.sessionGeneration == generation,
                      self.turnCoordinator.canFinishCall(callID, epoch: epoch) else { return }
                for event in try ShannonLiveVoiceClientEvent.realtimeFunctionResult(
                    callID: callID,
                    content: reply
                ) {
                    try transport.send(event)
                }
                _ = self.turnCoordinator.finishCall(callID, epoch: epoch)
                self.resumeRealtimeResponseIfReady()
                self.diagnostics.record("realtime.function.returned")
            } catch {
                guard !Task.isCancelled, let self, self.sessionGeneration == generation,
                      self.turnCoordinator.canFinishCall(callID, epoch: epoch) else { return }
                self.diagnostics.record(
                    "realtime.function.failed",
                    metadata: self.safeErrorMetadata(error)
                )
                if let fallback = try? ShannonLiveVoiceClientEvent.realtimeFunctionResult(
                    callID: callID,
                    content: "確認に失敗しました。推測せず、必要な情報をユーザーに短く聞き直してください。"
                ) {
                    do {
                        for event in fallback { try transport.send(event) }
                        _ = self.turnCoordinator.finishCall(callID, epoch: epoch)
                    } catch {
                        self.errorMessage = "検索結果を返せませんでした。もう一度話しかけてください。"
                    }
                }
                self.resumeRealtimeResponseIfReady()
            }
        }
    }
}
#endif
