import Foundation

enum ShannonVoiceDesignPreview {
    static var isEnabled: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains("-ShannonPreviewVoice")
#else
        false
#endif
    }
}

#if DEBUG && os(iOS) && canImport(WebRTC)
extension ShannonRealtimeVoiceSessionModel {
    func prepareDesignPreview() {
        phase = .speaking
        userTranscript = "シャノン、聞こえる？"
        shannonTranscript = "うん、ちゃんと聞こえてるよ。声に合わせて光も動いてる。"
        playbackLevel = 0.72
        microphoneLevel = 0
        errorMessage = nil
    }
}
#endif
