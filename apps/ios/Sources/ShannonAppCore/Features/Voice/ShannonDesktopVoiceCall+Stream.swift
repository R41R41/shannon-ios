#if os(macOS)
import Foundation

/// The Mac's voice conversation while 配信用の出力（OBS） is on (roadmap A18 S5, owner decision 2026-10-06). A stream
/// means others may be listening (`docs/body-contract.md`, "Audience"), so a voice conversation then is 「友人も一緒」,
/// with the existing guest rules (nothing of it is remembered as the owner's, his screens and draft are set aside):
/// a call running when the stream output is turned on switches to it, as the owner's own switch would, and a call
/// started while it is on starts in it. The Windows body ended the owner's call instead; the owner chose the switch.
extension ShannonDesktopVoiceCall {
    /// The mode a call starts in.
    nonisolated static func startingMode(streamOutputOn: Bool) -> ShannonVoiceParticipantMode {
        streamOutputOn ? .guest : .owner
    }

    /// While the stream output is on, the call does not go back to 本人だけ: turn the stream output off first.
    func keepsGuestForStream(switchingTo mode: ShannonVoiceParticipantMode) -> Bool {
        mode == .owner && streamOutputIsOn()
    }

    /// The 本人だけ／友人も一緒 control is held at 友人も一緒 meanwhile.
    public var participantIsHeldForStream: Bool {
        session.participantMode == .guest && streamOutputIsOn()
    }

    /// Follows the switch: when it is turned on, a call in 本人だけ (live, connecting or failed) becomes 「友人も一緒」.
    func followStreamOutput() {
        guard streamObserver == nil else { return }
        streamObserver = NotificationCenter.default.addObserver(forName: .shannonStreamOutputChanged, object: nil, queue: .main) { [weak self] note in
            let on = note.userInfo?[ShannonStreamOutput.isOnKey] as? Bool ?? false
            MainActor.assumeIsolated { if on { self?.streamOutputTurnedOn() } }
        }
    }

    func streamOutputTurnedOn() {
        guard isShown, session.participantMode == .owner else { return }
        ShannonVoiceDiagnostics.shared.record("gemini.session.stream_output.guest")
        switchParticipant(to: .guest)
    }
}
#endif
