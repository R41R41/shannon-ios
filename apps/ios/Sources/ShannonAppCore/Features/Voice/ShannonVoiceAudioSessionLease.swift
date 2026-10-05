@preconcurrency import AVFoundation

/// The shared audio session belongs to whoever activated it.
///
/// The dictation recorder and the reply player used to deactivate the session whenever they were
/// cancelled, including on every scene-phase change. That deactivation also reached a running voice
/// conversation, which owns the same session: its audio stopped and iOS suspended the app in the
/// background. A holder of this lease deactivates only what it activated itself. The Mac has no shared
/// session: there the lease only keeps count.
@MainActor
final class ShannonVoiceAudioSessionLease {
    private(set) var isHeld = false

    func activate() throws {
#if os(iOS)
        try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
#endif
        isHeld = true
    }

    func release() {
        guard isHeld else { return }
        isHeld = false
#if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
#endif
    }
}
