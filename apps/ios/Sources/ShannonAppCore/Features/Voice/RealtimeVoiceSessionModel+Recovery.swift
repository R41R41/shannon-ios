import Foundation

#if os(iOS) && canImport(WebRTC)
extension ShannonRealtimeVoiceSessionModel {
    func receiveAudioInterruption(_ event: ShannonRealtimeVoiceInterruptionEvent) {
        switch ShannonRealtimeVoiceRecoveryPolicy.interruptionAction(for: event, phase: phase) {
        case .ignore:
            break
        case .wait:
            phase = .connecting
            diagnostics.record("realtime.audio.interruption_began")
        case .resume:
            phase = sessionStartedAt == nil ? .connecting : .listening
            diagnostics.record("realtime.audio.interruption_resumed")
        case .fail:
            diagnostics.record("realtime.audio.interruption_ended_without_resume")
            fail("ほかの音声利用が終了しました。もう一度つなぐと会話を再開できます。")
        }
    }

    func scheduleDisconnectFailure(generation: Int) {
        guard phase.keepsSessionActive else { return }
        disconnectGraceTask?.cancel()
        phase = .connecting
        diagnostics.record("realtime.connection.disconnected")
        disconnectGraceTask = Task { [weak self] in
            try? await Task.sleep(for: ShannonRealtimeVoiceRecoveryPolicy.disconnectGracePeriod)
            guard !Task.isCancelled, self?.sessionGeneration == generation else { return }
            self?.diagnostics.record("realtime.connection.recovery_timed_out")
            self?.fail("音声接続が切れました。もう一度つなぎ直してください。")
        }
    }

    func safeErrorMetadata(_ error: Error) -> [String: String] {
        let value = error as NSError
        return ["domain": value.domain, "code": String(value.code)]
    }
}
#endif
