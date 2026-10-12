import Foundation
import SwiftUI

extension ShannonGeminiLiveSessionModel {
    /// A task's already-written public report (its short spoken form), spoken in the existing call. No owner utterance,
    /// model decision, history turn, or task stop is fabricated to make this delivery happen.
    @discardableResult
    func speakActivityReport(_ text: String, stillCurrent: @escaping @MainActor () -> Bool) -> Bool {
        guard phase == .listening, participantMode == .owner, !othersMayBeListening,
              pendingTurns.turns.isEmpty, !turnAssembler.hasFinalText, audioLevel < Self.answerSoundLevel,
              responseTask == nil, let transport, let streamSpeech, let call = sessionGenerationID,
              stillCurrent(), !text.isEmpty else { return false }
        let generation = UUID()
        responseGenerationID = generation
        activityReportGeneration = generation
        activityReportSourceCurrent = stillCurrent
        responseDelivery = ShannonVoiceResponseDelivery()
        latencyMeasurements.startResponse()
        shannonTranscript = text
        phase = .thinking
        responseTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.activityReportGeneration == generation {
                    self.activityReportGeneration = nil; self.activityReportSourceCurrent = nil
                }
                if self.responseGenerationID == generation {
                    self.responseGenerationID = nil; self.responseTask = nil
                    self.playbackLevel = 0; self.phase = .listening; self.markPlaybackEnded()
                }
            }
            do {
                // Scheduling is not permission: source, audience, and call may change before this task runs.
                try Task.checkCancellation()
                guard sessionGenerationID == call, responseGenerationID == generation, phase == .thinking,
                      participantMode == .owner, !othersMayBeListening,
                      pendingTurns.turns.isEmpty, !turnAssembler.hasFinalText,
                      audioLevel < Self.answerSoundLevel, stillCurrent() else { throw CancellationError() }
                let speech = try await streamSpeech(text, nil)
                try Task.checkCancellation()
                guard sessionGenerationID == call, responseGenerationID == generation,
                      !othersMayBeListening, stillCurrent() else { throw CancellationError() }
                try await consumeResponseSpeech(speech, text: text, generation: generation, runID: generation,
                    permitted: { !self.othersMayBeListening && stillCurrent() })
                try await transport.waitForPlayback()
            } catch is CancellationError {
                if responseGenerationID == generation { transport.discardPlayback(); shannonTranscript = "" }
            } catch {
                guard responseGenerationID == generation else { return }
                transport.discardPlayback()
                errorMessage = "途中の報告を声で伝えられませんでした。「いま」で読めます。"
            }
        }
        return true
    }
    /// Source withdrawal also discards PCM already scheduled in the audio player.
    func withdrawActivityReportIfStale() {
        guard let generation = activityReportGeneration, generation == responseGenerationID,
              othersMayBeListening || activityReportSourceCurrent?() != true else { return }
        cancelActivityReport()
    }
    func cancelActivityReport() {
        guard let generation = activityReportGeneration, generation == responseGenerationID else { return }
        interruptResponse()
        shannonTranscript = ""
        activityReportGeneration = nil; activityReportSourceCurrent = nil
    }
}

public struct ShannonActivityVoiceReporting: ViewModifier {
    let activity: ShannonConversationActivityModel
    let session: ShannonGeminiLiveSessionModel
    let threadID: String?
    public init(activity: ShannonConversationActivityModel, session: ShannonGeminiLiveSessionModel, threadID: String?) {
        self.activity = activity; self.session = session; self.threadID = threadID
    }
    public func body(content: Content) -> some View {
        content.onChange(of: activity.state) { session.withdrawActivityReportIfStale() }
            .onChange(of: activity.speechKey) { session.withdrawActivityReportIfStale() }
            .onChange(of: threadID) { session.cancelActivityReport() }
            .task(id: "\(activity.speechKey)|\(session.phase.rawValue)|\(threadID ?? "")") {
            guard let callStarted = session.callStartedAt,
                  let task = activity.nextReport(threadID: threadID, writtenAfter: callStarted),
                  let report = task.report, let words = activity.speech(for: report) else { return }
            // Nothing marks a report delivered when a call cannot take it. After an actual attempt,
            // barge-in or an uncertain audio result must not automatically replay the paid TTS.
            let started = session.speakActivityReport(words) {
                activity.reportIsCurrent(taskID: task.id, reportID: report.id, threadID: threadID)
            }
            if started { activity.markReportAttempted(report.id) }
        }
    }
}
