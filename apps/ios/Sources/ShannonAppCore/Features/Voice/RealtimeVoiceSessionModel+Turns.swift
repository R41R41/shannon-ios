import Foundation

#if os(iOS) && canImport(WebRTC)
@MainActor
extension ShannonRealtimeVoiceSessionModel {
    func invalidateVoiceWork() {
        liveDelegationTasks.values.forEach { $0.cancel() }
        liveDelegationTasks.removeAll()
        if engine == .realtime, let transport {
            for id in turnCoordinator.pendingCallIDs {
                if let events = try? ShannonLiveVoiceClientEvent.realtimeFunctionResult(
                    callID: id, content: "Cancelled by newer user input. Do not use or speak the previous result."
                ) { for event in events { try? transport.send(event) } }
            }
            if turnCoordinator.activeResponse != nil,
               let cancel = try? ShannonLiveVoiceClientEvent.responseControl("response.cancel") {
                try? transport.send(cancel)
            }
        }
    }

    func sendRealtimeUserItem(_ content: String, itemID: String) throws {
        guard let transport else { throw ShannonRealtimeVoiceTextError.sessionUnavailable }
        if let item = try ShannonLiveVoiceClientEvent.realtimeTextTurn(content: content, itemID: itemID).first {
            try transport.send(item)
        }
        turnCoordinator.requestResponse()
        resumeRealtimeResponseIfReady()
    }

    func resumeRealtimeResponseIfReady() {
        guard turnCoordinator.takeResponseRequest() else { return }
        do {
            try transport?.send(ShannonLiveVoiceClientEvent.responseControl("response.create"))
            phase = .thinking
        } catch {
            turnCoordinator.recoverResponseConflict()
            errorMessage = "応答を再開できませんでした。もう一度話しかけてください。"
        }
    }

    func handleRecoverableVoiceError(_ code: String?) -> Bool {
        switch code {
        case "conversation_already_has_active_response":
            turnCoordinator.recoverResponseConflict()
        case "response_cancel_not_active": break
        case "input_audio_buffer_commit_empty":
            phase = .listening
        default: return false
        }
        diagnostics.record("realtime.event.recovered", metadata: ["code": code ?? "unknown"])
        return true
    }

    func receiveCorrelated(_ packet: ShannonRealtimePacket, generation: Int) {
        if packet.kind == .speechStarted { invalidateVoiceWork() }
        if let completed = turnCoordinator.apply(packet) { persist(completed, generation: generation) }
        userTranscript = turnCoordinator.userText
        shannonTranscript = turnCoordinator.shannonText
        if let responseUsage = packet.usage { usage.append(responseUsage) }
        if !packet.responseID.isEmpty && !turnCoordinator.belongsToCurrentTurn(responseID: packet.responseID) {
            resumeRealtimeResponseIfReady()
            return
        }
        switch packet.kind {
        case .speechStarted: phase = .listening
        case .speechStopped, .responseStarted: phase = .thinking
        case .outputDelta: phase = .speaking
        case .functionCall:
            phase = .thinking
            beginRealtimeFunctionCall(callID: packet.callID, request: packet.text,
                generation: generation, responseID: packet.responseID)
        case .responseFinished:
            phase = turnCoordinator.isWorking ? .thinking : .listening
        case .playbackStopped:
            phase = turnCoordinator.isWorking ? .thinking : .listening
        default: break
        }
        resumeRealtimeResponseIfReady()
    }
}
#endif
