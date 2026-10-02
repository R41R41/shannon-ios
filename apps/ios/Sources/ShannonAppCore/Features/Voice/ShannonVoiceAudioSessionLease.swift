#if os(iOS)
@preconcurrency import AVFoundation

/// The shared audio session belongs to whoever activated it.
///
/// The dictation recorder and the reply player used to deactivate the session whenever they were
/// cancelled, including on every scene-phase change. That deactivation also reached a running voice
/// conversation, which owns the same session: its audio stopped and iOS suspended the app in the
/// background. A holder of this lease deactivates only what it activated itself.
@MainActor
final class ShannonVoiceAudioSessionLease {
    private(set) var isHeld = false

    func activate() throws {
        try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
        isHeld = true
    }

    func release() {
        guard isHeld else { return }
        isHeld = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
#endif
