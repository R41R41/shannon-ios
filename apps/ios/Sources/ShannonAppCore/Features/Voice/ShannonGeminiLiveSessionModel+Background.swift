import Foundation

/// A voice conversation that goes on after the owner leaves the app (owner decision 2026-10-02).
///
/// Leaving the foreground ends nothing: capture, playback, turns and history writes continue under the
/// `audio` background mode. Two things are added for the background: the call ends by itself after
/// `ShannonVoiceBackgroundSilence.limit` without speech from either side, through the same path as
/// the owner's own 終了, and its audio is brought back, or the call fails visibly, whenever the system
/// took the audio away.
extension ShannonGeminiLiveSessionModel {
    /// An audio failure reconnects the same call by itself at most this often.
    static let audioReconnectSpacing: TimeInterval = 30
    /// In the foreground, an interruption that has not reported its end after this long is tried from our side.
    static let interruptionPatience: TimeInterval = 20

    public func sceneDidEnterBackground(now: Date = Date()) {
        backgroundSilence.enteredBackground(at: now)
        guard backgroundWatchTask == nil else { return }
        backgroundWatchTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(ShannonVoiceBackgroundSilence.checkInterval))
                } catch { return }
                self?.endIfSilentInBackground()
            }
        }
    }

    public func sceneDidBecomeActive(now: Date = Date()) {
        // A call that stayed silent past the limit while the app was suspended ends before it is shown as live.
        endIfSilentInBackground(now: now)
        backgroundSilence.enteredForeground()
        backgroundWatchTask?.cancel()
        backgroundWatchTask = nil
        guard phase != .idle, phase != .failed else { return }
        transport?.resumeAudioIfNeeded()
    }

    /// Ends a call that has been silent in the background for the limit. A failed or still connecting
    /// call is ended too, so nothing is left behind unseen.
    func endIfSilentInBackground(now: Date = Date()) {
        // A reply in the making or in the air is not silence. Words of his that no reply is being made for (the
        // reply failed) are: otherwise such a call would stay open, microphone and all, until he came back.
        guard phase != .idle, backgroundSilence.shouldEnd(
            at: now, replyInProgress: responseTask != nil, interrupted: phase == .reconnecting
        ) else { return }
        ShannonVoiceDiagnostics.shared.record("gemini.session.background_silence.ended",
            metadata: ["phase": phase.rawValue])
        if let endAfterBackgroundSilence {
            endAfterBackgroundSilence()
        } else {
            finishGuestPeriod()
            stop()
        }
    }

    func handleAudioState(_ state: ShannonGeminiLiveAudioState) {
        switch state {
        case .interrupted:
            // Her reply cannot be heard now; what the owner said stays pending and is answered after the resume.
            interruptResponse()
            audioLevel = 0
            phase = .reconnecting
            interruptionGeneration &+= 1
            watchInterruption(interruptionGeneration)
        case .resumed:
            interruptionGeneration &+= 1
            guard phase == .reconnecting else { return }
            phase = .listening
            backgroundSilence.speech(at: Date())
            if !pendingTurns.turns.isEmpty { beginResponse() }
        }
    }

    /// iOS does not always report the end of an interruption. With the app in front the call must not stay
    /// "reconnecting" for ever, so the audio is tried from here every so often. While the interruption is still going
    /// on (a phone call answered from its banner) the try simply fails and is repeated later; it never ends the call.
    /// In the background nothing is tried: `sceneDidBecomeActive` picks the call up when he returns.
    private func watchInterruption(_ generation: Int) {
        Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(Self.interruptionPatience)) } catch { return }
            // Only the interruption that started this watch: a later one, a resume, or the call ending makes it stale.
            guard let self, self.interruptionGeneration == generation, self.phase == .reconnecting else { return }
            if !self.backgroundSilence.isInBackground, self.transport?.resumeAudio(endingCallOnFailure: false) == true { return }
            self.watchInterruption(generation)
        }
    }

    /// The audio could not be brought back in place (the route changed under the engine, or the media
    /// services were reset). The same call is connected again once; a second failure soon after is shown.
    func reconnectAfterAudioFailure(now: Date = Date()) -> Bool {
        if let last = lastAudioReconnectAt, now.timeIntervalSince(last) < Self.audioReconnectSpacing { return false }
        guard phase != .idle, phase != .failed else { return false }
        lastAudioReconnectAt = now
        ShannonVoiceDiagnostics.shared.record("gemini.session.audio.reconnect")
        interruptResponse()
        phase = .reconnecting
        Task { @MainActor [weak self] in await self?.retry() }
        return true
    }
}
