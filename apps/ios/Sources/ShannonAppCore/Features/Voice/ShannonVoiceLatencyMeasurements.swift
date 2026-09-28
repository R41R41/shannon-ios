import Foundation

struct ShannonVoiceLatencyMeasurements: Sendable {
    private(set) var responseStartedAt: TimeInterval?
    private(set) var firstAudioMilliseconds: Int?
    private(set) var firstTextMilliseconds: Int?
    private(set) var firstTTSByteMilliseconds: Int?
    private(set) var decisionMilliseconds: Int?

    mutating func startResponse(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        responseStartedAt = now
        firstAudioMilliseconds = nil
        firstTextMilliseconds = nil
        firstTTSByteMilliseconds = nil
        decisionMilliseconds = nil
    }

    mutating func recordFirstText(
        plan: ShannonVoicePlanDTO?,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        decisionMilliseconds = plan?.decisionLatencyMilliseconds ?? decisionMilliseconds
        guard firstTextMilliseconds == nil, let responseStartedAt else { return }
        firstTextMilliseconds = milliseconds(now - responseStartedAt)
    }

    mutating func recordFirstAudio(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard firstAudioMilliseconds == nil, let responseStartedAt else { return }
        firstAudioMilliseconds = milliseconds(now - responseStartedAt)
    }

    mutating func recordFirstTTSByte(
        requestStartedAt: TimeInterval?,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        guard firstTTSByteMilliseconds == nil, let requestStartedAt else { return }
        firstTTSByteMilliseconds = milliseconds(now - requestStartedAt)
    }

    func recordServerMetrics(_ metrics: ShannonVoiceServerMetricsDTO?) {
        guard let metrics else { return }
        ShannonVoiceDiagnostics.shared.record(
            "gemini.turn.server.metrics",
            metadata: [
                "context_ms": String(metrics.contextMilliseconds),
                "decision_ms": String(metrics.decisionMilliseconds),
                "first_model_token_ms": String(metrics.firstModelTokenMilliseconds),
                "model_complete_ms": String(metrics.modelCompleteMilliseconds),
                "turn_to_model_complete_ms": String(metrics.turnToModelCompleteMilliseconds ?? -1),
            ]
        )
    }

    mutating func reset() {
        responseStartedAt = nil
        firstAudioMilliseconds = nil
        firstTextMilliseconds = nil
        firstTTSByteMilliseconds = nil
        decisionMilliseconds = nil
    }

    private func milliseconds(_ interval: TimeInterval) -> Int {
        Int(max(0, interval) * 1_000)
    }
}
