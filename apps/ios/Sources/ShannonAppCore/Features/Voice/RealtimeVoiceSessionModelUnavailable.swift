import Foundation
import Observation

#if !(os(iOS) && canImport(WebRTC))
@MainActor
@Observable
public final class ShannonRealtimeVoiceSessionModel {
    public private(set) var phase: ShannonRealtimeVoicePhase = .failed
    public private(set) var userTranscript = ""
    public private(set) var shannonTranscript = ""
    public private(set) var errorMessage: String? = "ライブ音声はiPhoneで利用できます。"
    public private(set) var isMuted = false
    public private(set) var sessionStartedAt: Date?
    public private(set) var usage = ShannonRealtimeVoiceUsage.zero
    public private(set) var dailyRemainingSeconds: Int?
    public private(set) var engine: ShannonVoiceEngine = .realtime
    public private(set) var liveAudioSeconds: Double = 0
    public private(set) var participantMode: ShannonVoiceParticipantMode = .owner
    public private(set) var inputState = ShannonVoiceInputState()
    public private(set) var isSendingText = false
    public private(set) var textSendErrorMessage: String?
    public var canSendText: Bool { false }
    public var pendingToolCount: Int { 0 }

    public init() {}

    public func start(
        participantMode: ShannonVoiceParticipantMode,
        createCall: @escaping @MainActor (String, ShannonVoiceParticipantMode) async throws -> ShannonRealtimeVoiceCallDTO,
        performLiveDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void
    ) async {}

    public func toggleMute() {}
    public func selectInput(_ preference: ShannonVoiceInputPreference) {}
    public func sendText(_ content: String) async throws {
        throw ShannonRealtimeVoiceTextError.sessionUnavailable
    }
    public func stop() { phase = .idle }
}
#endif
