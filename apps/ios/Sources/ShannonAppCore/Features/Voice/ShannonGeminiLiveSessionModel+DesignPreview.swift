#if os(iOS) && DEBUG
import Foundation

/// Synthetic launch states for the voice call screen. Never uses real audio or conversation data.
extension ShannonGeminiLiveSessionModel {
    func prepareDesignPreview() {
        let arguments = ProcessInfo.processInfo.arguments
        participantMode = arguments.contains("-ShannonPreviewVoiceGuest") ? .guest : .owner
        userTranscript = "シャノン、今日の予定を一緒に整理して"
        shannonTranscript = "もちろん。まず優先したいことから確認しよう。"
        audioLevel = 0.34
        playbackLevel = 0.58
        errorMessage = nil
        failureRecovery = nil
        textSendState = .idle
        isMicrophoneMuted = arguments.contains("-ShannonPreviewVoiceMuted")
        callStartedAt = Date().addingTimeInterval(-83)
        if arguments.contains("-ShannonPreviewMicrophonePrimer") {
            phase = .requestingPermission
            let denied = arguments.contains("-ShannonPreviewPrimerDenied")
            microphonePrimerPhase = denied ? .denied : .explain
            if denied { fail("設定でマイクを許可すると、音声で話せます。", recovery: .openSettings) }
            return
        }
        if arguments.contains("-ShannonPreviewVoiceAudioFailed") {
            phase = .listening
            var fixtureLedger = ShannonPendingVoiceTurns()
            fixtureLedger.append(rawText: userTranscript, text: userTranscript, source: .speech)
            if let batch = fixtureLedger.batch() {
                do {
                    try responseDelivery.complete(.init(threadId: "synthetic-preview", model: "synthetic",
                        reply: shannonTranscript), batch: batch, ledger: &fixtureLedger)
                } catch { preconditionFailure("Invalid synthetic voice preview") }
            }
            errorMessage = responseDelivery.failureMessage
        } else if arguments.contains("-ShannonPreviewVoicePartialFailed") {
            phase = .listening
            responseDelivery = ShannonVoiceResponseDelivery()
            responseDelivery.scheduledAudio(seconds: 1)
            shannonTranscript = "まず優先したいことから……"
            errorMessage = responseDelivery.failureMessage
        } else if arguments.contains("-ShannonPreviewVoiceFailed") {
            phase = .failed
            errorMessage = "音声会話へ接続できませんでした。通信を確認して、もう一度お試しください。"
            failureRecovery = .reconnect
            textSendState = .failed(
                text: "続きはテキストで送って",
                message: "テキストを送信できませんでした。入力は保持されています。"
            )
        } else if arguments.contains("-ShannonPreviewVoiceReconnecting") {
            phase = .reconnecting
        } else if arguments.contains("-ShannonPreviewVoiceListening") {
            phase = .listening
        } else {
            phase = .speaking
        }
    }
}
#endif
