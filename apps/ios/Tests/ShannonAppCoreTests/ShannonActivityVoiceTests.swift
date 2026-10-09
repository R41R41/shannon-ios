import Foundation
import Testing
@testable import ShannonAppCore

@MainActor
struct ShannonActivityVoiceTests {
    private struct Refused: Error {}
    private final class Gate {
        var session: CheckedContinuation<ShannonGeminiLiveSessionDTO, Error>?
        var speech: CheckedContinuation<ShannonGeminiSpeechStream, Error>?
        var speechRequests = 0
    }
    private func connect(_ model: ShannonGeminiLiveSessionModel, gate: Gate) -> Task<Void, Never> {
        model.microphoneUsageIsDeclared = { true }
        model.microphonePermission = { .granted }
        model.requestMicrophonePermission = { true }
        return Task { @MainActor in
            await model.start(participantMode: .owner, speechProvider: .eleven,
                createSession: { _ in try await withCheckedThrowingContinuation { gate.session = $0 } },
                performDelegation: { _, _, _ in throw Refused() },
                performStreamingDelegation: { _, _, _, _ in throw Refused() },
                streamSpeech: { _, _ in
                    gate.speechRequests += 1
                    return try await withCheckedThrowingContinuation { gate.speech = $0 }
                },
                commitTurn: { _, _ in Issue.record("A progress report must not fabricate a history turn") },
                handleDelegationResponse: { _ in Issue.record("A progress report must not fabricate an owner response") })
        }
    }
    private func transport() -> ShannonGeminiLiveTransport {
        .init(session: .init(token: "fixture", model: "fixture", voice: "fixture", threadId: "talk", instructions: "", expiresAt: "", inputUsdPerMinute: 0, outputUsdPerMinute: 0),
            eventHandler: { _ in }, captureHandler: { _, _, _, _, _ in }, inputStateHandler: { _ in })
    }
    @Test("withdrawing a source cancels only the activity speech and keeps the call provider")
    func withdrawReport() async {
        let model = ShannonGeminiLiveSessionModel(), gate = Gate()
        let connecting = connect(model, gate: gate)
        while gate.session == nil { await Task.yield() }
        model.phase = .listening; model.transport = transport()
        var sourceVisible = true
        let admitted = model.speakActivityReport("一次資料を比較しています。", stillCurrent: { sourceVisible })
        #expect(admitted)
        while gate.speech == nil { await Task.yield() }
        #expect(model.pendingTurns.turns.isEmpty)
        #expect(model.speechProvider == .eleven)
        sourceVisible = false
        model.withdrawActivityReportIfStale()
        #expect(model.responseTask == nil)
        #expect(model.phase == .listening)
        #expect(model.shannonTranscript.isEmpty)
        #expect(model.transport != nil)
        gate.speech?.resume(throwing: Refused())
        model.stop(); gate.session?.resume(throwing: Refused()); await connecting.value
    }
    @Test("withdrawal between scheduling and execution sends no private text to TTS")
    func withdrawBeforeHandoff() async {
        let model = ShannonGeminiLiveSessionModel(), gate = Gate()
        let connecting = connect(model, gate: gate)
        while gate.session == nil { await Task.yield() }
        model.phase = .listening; model.transport = transport()
        var sourceVisible = true
        let admitted = model.speakActivityReport("撤回された出所の報告", stillCurrent: { sourceVisible })
        #expect(admitted)
        sourceVisible = false
        // The queued response task has not run yet: no yield occurs between admission and withdrawal.
        while model.responseTask != nil { await Task.yield() }
        #expect(gate.speechRequests == 0)
        #expect(model.shannonTranscript.isEmpty)
        #expect(model.phase == .listening)
        model.stop(); gate.session?.resume(throwing: Refused()); await connecting.value
    }
    @Test("pending owner words and guest presence reject unsolicited activity speech")
    func ownerTakesPriority() async {
        let model = ShannonGeminiLiveSessionModel(), gate = Gate()
        let connecting = connect(model, gate: gate)
        while gate.session == nil { await Task.yield() }
        model.phase = .listening; model.transport = transport()
        model.appendUtterance(rawText: "今何してる？", text: "今何してる？", source: .typed)
        let rejectedForInput = model.speakActivityReport("調べています。", stillCurrent: { true })
        #expect(!rejectedForInput)
        #expect(model.pendingTurns.turns.count == 1)
        model.pendingTurns.reset(); model.participantMode = .guest
        let rejectedForGuest = model.speakActivityReport("調べています。", stillCurrent: { true })
        #expect(!rejectedForGuest)
        #expect(gate.speech == nil)
        model.stop(); gate.session?.resume(throwing: Refused()); await connecting.value
    }
}
