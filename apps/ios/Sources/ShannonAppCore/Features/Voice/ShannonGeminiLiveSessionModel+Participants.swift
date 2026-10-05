import Foundation
#if os(iOS)
import UIKit
#endif

enum ShannonVoiceParticipantSwitchOrigin: String, Sendable {
    case control, spoken
}

extension ShannonGeminiLiveSessionModel {
    /// Changes who Shannon is talking with inside the running call. Recognition, playback, the
    /// call clock and mute are untouched; only what later turns may read and where they go changes.
    func switchParticipantMode(
        to mode: ShannonVoiceParticipantMode,
        origin: ShannonVoiceParticipantSwitchOrigin = .control
    ) {
        guard mode != participantMode, phase != .idle else { return }
        // A reply still being generated belongs to the mode it was asked in; start it again.
        if responseDelivery.response == nil { interruptResponse() }
        if mode == .owner {
            // The period is over: hand its turns over to be remembered before owner turns resume.
            finishGuestPeriod()
            // Nothing heard in 「友人も一緒」 may be answered with, or saved to, the owner's context.
            pendingTurns.reset()
            discardUnfinalizedInput()
            userTranscript = ""
            shannonTranscript = ""
            textSendState = .idle
        } else {
            // Into 「友人も一緒」: the owner's words and her last reply on screen, and owner text that failed to
            // send, are not left for the others at the table to read. What he said and was not yet answered stays
            // pending and is answered in the in-call context, but is never shown again; an owner reply still
            // streaming does not write onto the screen either (`mayShowReply`).
            pendingTurns.hideAll()
            // Owner speech in flight at the tap (already being assembled, or still being recognised) is his too.
            if origin == .control { ownerWordsUntil = ProcessInfo.processInfo.systemUptime + Self.ownerWordsAfterSwitch }
            userTranscript = ""
            shannonTranscript = ""
            textSendState = .idle
        }
        participantMode = mode
        ShannonVoiceDiagnostics.shared.record("gemini.participant.switched",
            metadata: ["mode": mode.rawValue, "origin": origin.rawValue])
        // What is on the screens around the call (an unshared photo, the owner's failed text) follows the switch.
        participantModeDidChange?(mode)
        guard mode == .guest else { return }
        guestCall.beginGuestPeriod()
        // By the control nobody has spoken yet, so Shannon opens with the greeting herself.
        if origin == .control, transport != nil, phase != .failed {
            pendingTurns.append(rawText: "", text: ShannonVoiceGuestCallState.introductionCue,
                source: .typed, isIntroductionCue: true)
            beginResponse()
        }
    }

    /// Adds one finished utterance, first applying the owner's spoken cue that a friend has joined.
    func appendUtterance(
        id: UUID = UUID(), rawText: String, text: String, source: ShannonVoiceUtteranceSource,
        addressedByName: Bool = false, followsShannonTurn: Bool = false, ownersWords: Bool = false
    ) {
        var localReply: String?
        var switchedNow = false
        if participantMode == .owner {
            let now = ProcessInfo.processInfo.systemUptime
            let answersQuestion = guestCall.takeCompanionQuestion(now: now)
            // A sentence split by a pause is judged together with what is still unanswered.
            let heard = [pendingTurns.displayText, rawText].filter { !$0.isEmpty }.joined(separator: "\n")
            let cue = ShannonVoiceCompanionCue.detect(in: rawText) ?? ShannonVoiceCompanionCue.detect(in: heard)
            if cue == .switchToGuest || (answersQuestion && ShannonVoiceCompanionCue.confirms(rawText)) {
                switchParticipantMode(to: .guest, origin: .spoken)
                switchedNow = true
            } else if answersQuestion, ShannonVoiceCompanionCue.denies(rawText) {
                guestCall.companionDenied()
            } else if cue == .ask {
                localReply = ShannonVoiceCompanionCue.question
            }
        }
        // The owner's words that switched the call are his own: answered, not shown to the others.
        pendingTurns.append(id: id, rawText: rawText, text: text, source: source,
            addressedByName: addressedByName, followsShannonTurn: followsShannonTurn, localReply: localReply,
            hidden: switchedNow || ownersWords)
    }

    public func shareCameraSnapshot(
        jpegData: Data,
        analyze: @escaping @MainActor (Data) async throws -> String
    ) async throws {
        guard participantMode.allowsCameraSharing else { throw ShannonRealtimeVoiceCameraError.sessionUnavailable }
        let generation = sessionGenerationID
        let description = try await analyze(jpegData)
        guard sessionGenerationID == generation, participantMode.allowsCameraSharing,
              transport != nil else { throw ShannonRealtimeVoiceCameraError.sessionUnavailable }
        interruptResponse()
        pendingTurns.append(rawText: "写真を共有しました。",
            text: "いま共有した写真を見て、会話の流れに合わせて短くコメントして。画像の内容: \(description)",
            source: .camera)
        beginResponse()
    }


    /// Closes the running 「友人も一緒」 period, if any, and hands it to whoever remembers calls.
    func finishGuestPeriod() {
        guard let period = guestCall.endGuestPeriod() else { return }
        guestPeriodEnded?(period)
    }

    /// How long after a switch into 「友人も一緒」 by the control an utterance that finalises is still the owner's: the
    /// recogniser's lag behind the end of speech (about a second) and the longest pause the assembler waits (0.42 s).
    /// What he said just before the tap is answered, but never shown or kept as the guests' words.
    static let ownerWordsAfterSwitch: TimeInterval = 1.5

    /// An utterance finalising now is the owner's from before the switch.
    var finalisesAsOwnersWords: Bool {
        guard participantMode == .guest, let until = ownerWordsUntil else { return false }
        return ProcessInfo.processInfo.systemUptime <= until
    }

    /// Words of a reply asked in 本人だけ that arrive once the call is 「友人も一緒」 (what she says about a look, behind a
    /// completed reply that the switch does not interrupt) are not written on screen.
    func mayShowReply(of mode: ShannonVoiceParticipantMode) -> Bool {
        !(mode == .owner && participantMode == .guest)
    }

    /// Owner mode: someone may be listening, so protected memories are not read out and the turn is marked.
    var companionSuspected: Bool { participantMode == .owner && guestCall.companionSuspected }

    /// Someone other than the owner may hear the phone now: 「友人も一緒」, or a companion he mentioned.
    /// While this holds the app never says that only he can hear.
    public var othersMayBeListening: Bool {
        phase != .idle && (participantMode == .guest || guestCall.companionSuspected)
    }

    /// Keeps the call screen readable on a table. Released when the call ends. On the Mac the call also keeps
    /// the computer from sleeping by itself: speaking is not use that macOS counts, and a sleeping Mac ends the call.
    func setKeepsScreenAwake(_ awake: Bool) {
#if os(iOS)
        guard UIApplication.shared.isIdleTimerDisabled != awake else { return }
        UIApplication.shared.isIdleTimerDisabled = awake
#else
        if awake, awakeActivity == nil {
            awakeActivity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated, .idleDisplaySleepDisabled], reason: "A voice conversation with Shannon")
        } else if !awake, let activity = awakeActivity {
            ProcessInfo.processInfo.endActivity(activity)
            awakeActivity = nil
        }
#endif
    }
}

/// Speaks a fixed line through the normal reply path without asking the model.
enum ShannonVoiceLocalReply {
    static let threadID = "local-reply"

    @MainActor
    static func deliver(
        _ text: String, onSegment: ShannonVoiceSegmentHandler
    ) async -> ShannonLiveVoiceDelegationResponseDTO {
        await onSegment(text, nil)
        return ShannonLiveVoiceDelegationResponseDTO(threadId: threadID, model: "local-rule", reply: text)
    }
}
