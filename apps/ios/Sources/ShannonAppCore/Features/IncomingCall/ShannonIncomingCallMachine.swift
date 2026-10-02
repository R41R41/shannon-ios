import Foundation

/// Why the system's call screen is told a call is over.
public enum ShannonCallEndReason: Equatable, Sendable {
    /// Nobody answered: the phone shows a missed call.
    case unanswered
    /// The conversation ended from Shannon's side (it finished, or it could not go on).
    case remoteEnded
    /// The owner is already talking with her in the app, or this call was handled before.
    case answeredElsewhere
    /// The call could not be shown or heard.
    case failed
}

/// What the app does next. The machine decides; `ShannonIncomingCallCoordinator` performs.
public enum ShannonIncomingCallEffect: Equatable, Sendable {
    /// Report an incoming call to the system. It comes first for every push, whatever the push is: iOS ends an app
    /// that receives a VoIP push and does not report a call.
    case showIncoming(UUID)
    case endSystemCall(UUID, ShannonCallEndReason)
    /// Tell the server what became of the call.
    case report(callID: String, ShannonIncomingCallOutcome)
    case scheduleRingTimeout(UUID, at: Date)
    case scheduleConnectTimeout(UUID)
    case cancelTimeouts
    /// Set the audio session's category for a call. The system activates the session; the app never does.
    case prepareAudio
    /// Take her words for this call from the server.
    case claim(reachOutID: String, callID: String)
    case speak(String)
    case stopSpeaking
    case startConversation(threadID: String)
    case stopConversation
    case setMuted(Bool)
}

/// One call from Shannon, from the push to its end (owner decision 2026-10-03).
///
/// ringing → (he answers) connecting → (audio is active and her words arrived) speaking → conversation → over.
/// He declines, or nobody answers before the ring ends: over, and the server is told which.
///
/// The machine holds no audio, no network and no system object: it turns events into effects, so every
/// path can be tested. One call at a time; any other push is still shown to the system and ended at once.
public struct ShannonIncomingCallMachine: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case ringing
        /// He answered; waiting for the system to activate the audio and for her words.
        case connecting
        /// Her own line, in her voice, before anything else.
        case speaking
        /// The ordinary voice conversation on her message's Talk.
        case conversation
    }

    public struct Call: Equatable, Sendable {
        public let id: UUID
        public let callID: String
        public let reachOutID: String
        public let threadID: String
        public let expiresAt: Date
        public var phase: Phase
        var audioActive = false
        var line: String?
        var muted = false
    }

    public private(set) var call: Call?
    /// Calls this launch already saw, so a push that arrives twice does not ring twice.
    private var seen: [UUID] = []
    static let maximumSeen = 20

    public init() {}

    /// A call is ringing or going on: the audio session is the call's, and nothing else may take it.
    public var isActive: Bool { call != nil }

    /// A VoIP push arrived. `fresh` is an identifier the caller made for a call that is only shown to be ended.
    /// `busy`: the owner is in a conversation with her in the app, or dictating, or a message is on its way.
    public mutating func push(_ payload: ShannonIncomingCallPayload?, fresh: UUID, now: Date, busy: Bool, enabled: Bool) -> [ShannonIncomingCallEffect] {
        guard let payload else {
            // Not a call we understand. It is shown and ended, and nothing is told to the server: there is no call to name.
            return [.showIncoming(fresh), .endSystemCall(fresh, .failed)]
        }
        if seen.contains(payload.id) {
            // The same call again: the first one stands. The system cannot be shown one identifier twice.
            return [.showIncoming(fresh), .endSystemCall(fresh, .answeredElsewhere)]
        }
        remember(payload.id)
        if now >= payload.expiresAt {
            return [.showIncoming(payload.id), .endSystemCall(payload.id, .unanswered), .report(callID: payload.callID, .unanswered)]
        }
        if call != nil || busy {
            // She never calls into a conversation; a push that arrives during one is ended without ringing on.
            return [.showIncoming(payload.id), .endSystemCall(payload.id, .answeredElsewhere), .report(callID: payload.callID, .failed)]
        }
        if !enabled {
            // The owner switched calls off after the server last heard from this phone.
            return [.showIncoming(payload.id), .endSystemCall(payload.id, .failed), .report(callID: payload.callID, .failed)]
        }
        call = Call(id: payload.id, callID: payload.callID, reachOutID: payload.reachOutID, threadID: payload.threadID,
                    expiresAt: payload.expiresAt, phase: .ringing)
        return [.showIncoming(payload.id), .scheduleRingTimeout(payload.id, at: payload.expiresAt)]
    }

    /// The system did not show the call. `silenced`: a Focus or Do Not Disturb kept it from ringing, which for her is a call nobody answered.
    public mutating func showFailed(_ id: UUID, silenced: Bool) -> [ShannonIncomingCallEffect] {
        guard let current = call, current.id == id, current.phase == .ringing else { return [] }
        call = nil
        return [.cancelTimeouts, .report(callID: current.callID, silenced ? .unanswered : .failed)]
    }

    /// He answered: from the screen, the earphone button, or the system's auto-answer.
    public mutating func answer(_ id: UUID) -> [ShannonIncomingCallEffect] {
        guard var current = call, current.id == id, current.phase == .ringing else { return [] }
        current.phase = .connecting
        call = current
        return [.cancelTimeouts, .prepareAudio, .claim(reachOutID: current.reachOutID, callID: current.callID), .scheduleConnectTimeout(id)]
    }

    /// The system activated the audio session for the call.
    public mutating func audioActivated() -> [ShannonIncomingCallEffect] {
        guard var current = call else { return [] }
        current.audioActive = true
        call = current
        return speakIfReady()
    }

    public mutating func audioDeactivated() -> [ShannonIncomingCallEffect] {
        guard var current = call else { return [] }
        current.audioActive = false
        call = current
        return []
    }

    /// Her words arrived for this call.
    public mutating func claimed(callID: String, line: String) -> [ShannonIncomingCallEffect] {
        guard var current = call, current.callID == callID, current.phase == .connecting, current.line == nil else { return [] }
        current.line = line
        call = current
        return speakIfReady()
    }

    /// Her words could not be taken: the call is over on the server, or the server could not be reached.
    public mutating func claimFailed(callID: String) -> [ShannonIncomingCallEffect] {
        guard let current = call, current.callID == callID, current.phase == .connecting else { return [] }
        call = nil
        return [.cancelTimeouts, .endSystemCall(current.id, .failed), .report(callID: current.callID, .failed)]
    }

    /// Her line ended, heard or not. `canListen`: the microphone is permitted, so a conversation can follow.
    public mutating func lineFinished(canListen: Bool) -> [ShannonIncomingCallEffect] {
        guard var current = call, current.phase == .speaking else { return [] }
        guard canListen else {
            call = nil
            return [.endSystemCall(current.id, .remoteEnded)]
        }
        current.phase = .conversation
        call = current
        return [.startConversation(threadID: current.threadID)] + (current.muted ? [.setMuted(true)] : [])
    }

    /// The conversation is over: it ended in the app, after silence, or it could not start.
    public mutating func conversationEnded() -> [ShannonIncomingCallEffect] {
        guard let current = call, current.phase == .conversation else { return [] }
        call = nil
        return [.endSystemCall(current.id, .remoteEnded)]
    }

    /// He ended the call from the system's screen or the earphone button. The system already knows; nothing is reported back to it.
    public mutating func hangUp(_ id: UUID) -> [ShannonIncomingCallEffect] {
        guard let current = call, current.id == id else { return [] }
        call = nil
        switch current.phase {
        case .ringing:
            return [.cancelTimeouts, .report(callID: current.callID, .declined)]
        case .connecting:
            // He hung up before a word of hers: for her that is a call he chose not to take. If the server already
            // counted it as answered, that stands.
            return [.cancelTimeouts, .report(callID: current.callID, .declined)]
        case .speaking:
            return [.stopSpeaking]
        case .conversation:
            return [.stopConversation]
        }
    }

    /// The system's mute button. During the conversation it is the conversation's mute; before it, it is kept for it.
    public mutating func muted(_ id: UUID, _ muted: Bool) -> [ShannonIncomingCallEffect] {
        guard var current = call, current.id == id else { return [] }
        current.muted = muted
        call = current
        return current.phase == .conversation ? [.setMuted(muted)] : []
    }

    /// The ring ended and nobody answered.
    public mutating func ringTimedOut(_ id: UUID) -> [ShannonIncomingCallEffect] {
        guard let current = call, current.id == id, current.phase == .ringing else { return [] }
        call = nil
        return [.endSystemCall(id, .unanswered), .report(callID: current.callID, .unanswered)]
    }

    /// He answered, and the audio or her words never came.
    public mutating func connectTimedOut(_ id: UUID) -> [ShannonIncomingCallEffect] {
        guard let current = call, current.id == id, current.phase == .connecting else { return [] }
        call = nil
        // With her words in hand the server already counts the call as answered; a report then changes nothing.
        return [.endSystemCall(id, .failed), .report(callID: current.callID, .failed)]
    }

    /// The system dropped every call (its provider was reset): whatever runs stops, and nothing is reported to the system.
    public mutating func reset() -> [ShannonIncomingCallEffect] {
        guard let current = call else { return [] }
        call = nil
        switch current.phase {
        case .ringing: return [.cancelTimeouts, .report(callID: current.callID, .failed)]
        case .connecting: return [.cancelTimeouts, .report(callID: current.callID, .failed)]
        case .speaking: return [.stopSpeaking]
        case .conversation: return [.stopConversation]
        }
    }

    private mutating func speakIfReady() -> [ShannonIncomingCallEffect] {
        guard var current = call, current.phase == .connecting, current.audioActive, let line = current.line else { return [] }
        current.phase = .speaking
        call = current
        return [.cancelTimeouts, .speak(line)]
    }

    private mutating func remember(_ id: UUID) {
        seen.append(id)
        if seen.count > Self.maximumSeen { seen.removeFirst(seen.count - Self.maximumSeen) }
    }
}
