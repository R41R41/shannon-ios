#if os(iOS)
import Foundation
import UIKit

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
        }
        participantMode = mode
        ShannonVoiceDiagnostics.shared.record("gemini.participant.switched",
            metadata: ["mode": mode.rawValue, "origin": origin.rawValue])
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
        addressedByName: Bool = false, followsShannonTurn: Bool = false
    ) {
        var localReply: String?
        if participantMode == .owner {
            let now = ProcessInfo.processInfo.systemUptime
            let answersQuestion = guestCall.takeCompanionQuestion(now: now)
            // A sentence split by a pause is judged together with what is still unanswered.
            let heard = [pendingTurns.displayText, rawText].filter { !$0.isEmpty }.joined(separator: "\n")
            let cue = ShannonVoiceCompanionCue.detect(in: rawText) ?? ShannonVoiceCompanionCue.detect(in: heard)
            if cue == .switchToGuest || (answersQuestion && ShannonVoiceCompanionCue.confirms(rawText)) {
                switchParticipantMode(to: .guest, origin: .spoken)
            } else if answersQuestion, ShannonVoiceCompanionCue.denies(rawText) {
                guestCall.companionDenied()
            } else if cue == .ask {
                localReply = ShannonVoiceCompanionCue.question
            }
        }
        pendingTurns.append(id: id, rawText: rawText, text: text, source: source,
            addressedByName: addressedByName, followsShannonTurn: followsShannonTurn, localReply: localReply)
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

    /// Owner mode: someone may be listening, so protected memories are not read out and the turn is marked.
    var companionSuspected: Bool { participantMode == .owner && guestCall.companionSuspected }

    /// Keeps the call screen readable on a table. Released when the call ends.
    func setKeepsScreenAwake(_ awake: Bool) {
        guard UIApplication.shared.isIdleTimerDisabled != awake else { return }
        UIApplication.shared.isIdleTimerDisabled = awake
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
#endif
