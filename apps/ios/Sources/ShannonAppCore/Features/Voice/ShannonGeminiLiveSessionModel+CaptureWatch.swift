import Foundation

/// Whether the microphone still delivers buffers while a call is live. An engine can report itself running and
/// yet hear nothing (a Mac microphone that went away under voice processing); such a call must not look alive.
struct ShannonVoiceCaptureWatch: Equatable, Sendable {
    /// Seconds without a single buffer that make a live call deaf.
    static let limit: TimeInterval = 6
    private(set) var startedAt: TimeInterval?
    private(set) var lastBufferAt: TimeInterval?

    mutating func start(at now: TimeInterval) {
        startedAt = now
        lastBufferAt = nil
    }

    mutating func stop() {
        startedAt = nil
        lastBufferAt = nil
    }

    mutating func buffer(at now: TimeInterval) {
        guard startedAt != nil else { return }
        lastBufferAt = now
    }

    func isDeaf(at now: TimeInterval) -> Bool {
        guard let startedAt else { return false }
        return now - (lastBufferAt ?? startedAt) > Self.limit
    }
}

extension ShannonGeminiLiveSessionModel {
    /// The audio could not be kept running: the same call reconnects once, and a second failure soon after is shown.
    func audioFailed() {
        if reconnectAfterAudioFailure() { return }
        connectionEnded()
    }

    func connectionEnded() {
        fail("音声会話の接続が終了しました。もう一度つないでください。", recovery: .reconnect)
    }

    /// On the Mac, a live call checks every two seconds that the microphone still delivers buffers (muted input
    /// delivers silence, which counts). Deaf for `ShannonVoiceCaptureWatch.limit` seconds is an audio failure.
    /// The iPhone's audio session reports its own interruptions, so it is not watched there.
    func watchCapture() {
#if os(macOS)
        guard captureWatchTask == nil else { return }
        captureWatch.start(at: ProcessInfo.processInfo.systemUptime)
        captureWatchTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard let self else { return }
                guard [.listening, .thinking, .speaking].contains(self.phase) else { continue }
                if self.captureWatch.isDeaf(at: ProcessInfo.processInfo.systemUptime) {
                    ShannonVoiceDiagnostics.shared.record("gemini.audio.capture.deaf")
                    self.stopWatchingCapture()
                    self.interruptResponse()
                    self.audioFailed()
                    return
                }
            }
        }
#endif
    }

    func stopWatchingCapture() {
        captureWatchTask?.cancel()
        captureWatchTask = nil
        captureWatch.stop()
    }
}
