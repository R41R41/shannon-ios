import Foundation

public enum ShannonRealtimeVoicePhase: Equatable, Sendable {
    case idle
    case requestingPermission
    case connecting
    case listening
    case thinking
    case speaking
    case failed

    public var japaneseLabel: String {
        switch self {
        case .idle: "音声で話す"
        case .requestingPermission: "マイクを準備中"
        case .connecting: "シャノンにつないでいる…"
        case .listening: "聞いている"
        case .thinking: "考えている"
        case .speaking: "話している"
        case .failed: "接続できませんでした"
        }
    }

    var keepsSessionActive: Bool {
        switch self {
        case .requestingPermission, .connecting, .listening, .thinking, .speaking:
            true
        case .idle, .failed:
            false
        }
    }
}

public enum ShannonRealtimeVoiceRecoveryPolicy {
    public static let disconnectGracePeriod: Duration = .seconds(5)

    public static func interruptionAction(
        for event: ShannonRealtimeVoiceInterruptionEvent,
        phase: ShannonRealtimeVoicePhase
    ) -> ShannonRealtimeVoiceInterruptionAction {
        guard phase.keepsSessionActive else { return .ignore }
        switch event {
        case .began:
            return .wait
        case .ended(shouldResume: true):
            return .resume
        case .ended(shouldResume: false):
            return .fail
        }
    }
}

public enum ShannonRealtimeVoiceInterruptionEvent: Equatable, Sendable {
    case began
    case ended(shouldResume: Bool)
}

public enum ShannonRealtimeVoiceInterruptionAction: Equatable, Sendable {
    case ignore
    case wait
    case resume
    case fail
}

public struct ShannonRealtimeVoiceUsage: Equatable, Sendable {
    public private(set) var totalTokens: Int
    public private(set) var inputTokens: Int
    public private(set) var outputTokens: Int
    public private(set) var cachedInputTokens: Int
    public private(set) var inputAudioTokens: Int
    public private(set) var outputAudioTokens: Int

    public static let zero = ShannonRealtimeVoiceUsage()

    public init(
        totalTokens: Int = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cachedInputTokens: Int = 0,
        inputAudioTokens: Int = 0,
        outputAudioTokens: Int = 0
    ) {
        self.totalTokens = max(0, totalTokens)
        self.inputTokens = max(0, inputTokens)
        self.outputTokens = max(0, outputTokens)
        self.cachedInputTokens = max(0, cachedInputTokens)
        self.inputAudioTokens = max(0, inputAudioTokens)
        self.outputAudioTokens = max(0, outputAudioTokens)
    }

    public mutating func append(_ value: ShannonRealtimeVoiceUsage) {
        totalTokens += value.totalTokens
        inputTokens += value.inputTokens
        outputTokens += value.outputTokens
        cachedInputTokens += value.cachedInputTokens
        inputAudioTokens += value.inputAudioTokens
        outputAudioTokens += value.outputAudioTokens
    }
}

public enum ShannonRealtimeVoiceBudgetPolicy {
    public static let maximumSessionDurationSeconds = 10 * 60

    public static func remainingSeconds(startedAt: Date, now: Date) -> Int {
        let elapsed = max(0, Int(now.timeIntervalSince(startedAt)))
        return max(0, maximumSessionDurationSeconds - elapsed)
    }

    public static func remainingLabel(startedAt: Date, now: Date) -> String {
        let seconds = remainingSeconds(startedAt: startedAt, now: now)
        return String(format: "残り %02d:%02d", seconds / 60, seconds % 60)
    }

    public static func dailyRemainingLabel(seconds: Int) -> String {
        "本日あと最大 \(max(0, seconds) / 60)分"
    }
}

public enum ShannonRealtimeVoiceFailurePresentation {
    public static func startMessage(for error: Error) -> String {
        guard let apiError = error as? ShannonAPIError,
              case let .realtimeVoiceRejected(status, code) = apiError else {
            return "ライブ音声に接続できませんでした。少し待ってもう一度お試しください。"
        }
        switch code {
        case "VOICE_REALTIME_DAILY_ALLOWANCE_EXHAUSTED":
            return "今日はライブ音声を十分使いました。テキスト会話は引き続き使えます。"
        case "RATE_LIMITED":
            return "短時間に接続が続きました。少し待ってからもう一度お試しください。"
        case "VOICE_REALTIME_NOT_CONFIGURED":
            return "ライブ音声は現在利用できません。テキスト会話は引き続き使えます。"
        default:
            return status == 401
                ? "Shannonとの接続を設定し直してから、もう一度お試しください。"
                : "ライブ音声に接続できませんでした。少し待ってもう一度お試しください。"
        }
    }
}

public enum ShannonRealtimeVoiceEvent: Equatable, Sendable {
    case sessionReady
    case speechStarted
    case speechStopped
    case inputTranscriptDelta(String)
    case inputTranscriptDone(String)
    case outputTranscriptDelta(String)
    case outputTranscriptDone(String)
    case responseStarted
    case responseFinished(ShannonRealtimeVoiceUsage?)
    case failed(String?)

    public static func decode(_ data: Data) -> Self? {
        guard let value = try? JSONSerialization.jsonObject(with: data),
              let object = value as? [String: Any],
              let type = object["type"] as? String else { return nil }
        switch type {
        case "session.created", "session.updated": return .sessionReady
        case "input_audio_buffer.speech_started": return .speechStarted
        case "input_audio_buffer.speech_stopped": return .speechStopped
        case "conversation.item.input_audio_transcription.delta":
            return .inputTranscriptDelta(object["delta"] as? String ?? "")
        case "conversation.item.input_audio_transcription.completed":
            return .inputTranscriptDone(object["transcript"] as? String ?? "")
        case "response.output_audio_transcript.delta", "response.audio_transcript.delta":
            return .outputTranscriptDelta(object["delta"] as? String ?? "")
        case "response.output_audio_transcript.done", "response.audio_transcript.done":
            return .outputTranscriptDone(object["transcript"] as? String ?? "")
        case "response.created": return .responseStarted
        case "response.done":
            let response = object["response"] as? [String: Any]
            return .responseFinished(decodeUsage(response?["usage"]))
        case "error":
            let error = object["error"] as? [String: Any]
            let code = error?["code"] as? String ?? error?["type"] as? String
            return .failed(code)
        default: return nil
        }
    }

    private static func decodeUsage(_ value: Any?) -> ShannonRealtimeVoiceUsage? {
        guard let usage = value as? [String: Any] else { return nil }
        let inputDetails = usage["input_token_details"] as? [String: Any]
        let outputDetails = usage["output_token_details"] as? [String: Any]
        return ShannonRealtimeVoiceUsage(
            totalTokens: usage["total_tokens"] as? Int ?? 0,
            inputTokens: usage["input_tokens"] as? Int ?? 0,
            outputTokens: usage["output_tokens"] as? Int ?? 0,
            cachedInputTokens: inputDetails?["cached_tokens"] as? Int ?? 0,
            inputAudioTokens: inputDetails?["audio_tokens"] as? Int ?? 0,
            outputAudioTokens: outputDetails?["audio_tokens"] as? Int ?? 0
        )
    }
}

public struct ShannonRealtimeVoiceTranscriptState: Equatable, Sendable {
    public private(set) var userText = ""
    public private(set) var shannonText = ""
    private var completedUserText = ""
    private var completedShannonText = ""

    public init() {}

    public mutating func apply(_ event: ShannonRealtimeVoiceEvent) -> (user: String, shannon: String)? {
        switch event {
        case .speechStarted:
            userText = ""
            completedUserText = ""
            shannonText = ""
            completedShannonText = ""
        case .inputTranscriptDelta(let delta):
            userText += delta
        case .inputTranscriptDone(let transcript):
            completedUserText = normalized(transcript, fallback: userText)
            userText = completedUserText
        case .outputTranscriptDelta(let delta):
            shannonText += delta
        case .outputTranscriptDone(let transcript):
            completedShannonText = normalized(transcript, fallback: shannonText)
            shannonText = completedShannonText
        default:
            break
        }
        guard !completedUserText.isEmpty, !completedShannonText.isEmpty else { return nil }
        let turn = (completedUserText, completedShannonText)
        completedUserText = ""
        completedShannonText = ""
        return turn
    }

    private func normalized(_ value: String, fallback: String) -> String {
        let preferred = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return preferred.isEmpty ? fallback.trimmingCharacters(in: .whitespacesAndNewlines) : preferred
    }
}

public struct ShannonRealtimeOfferDiagnostics: Equatable, Sendable {
    public let byteCount: Int
    public let audioSectionCount: Int
    public let dataSectionCount: Int
    public let candidateCount: Int

    public init(sdp: String) {
        byteCount = sdp.utf8.count
        let lines = sdp.split(whereSeparator: \.isNewline)
        audioSectionCount = lines.count { $0.hasPrefix("m=audio ") }
        dataSectionCount = lines.count { $0.hasPrefix("m=application ") }
        candidateCount = lines.count { $0.hasPrefix("a=candidate:") }
    }

    public var metadata: [String: String] {
        [
            "bytes": String(byteCount),
            "audio_sections": String(audioSectionCount),
            "data_sections": String(dataSectionCount),
            "candidates": String(candidateCount),
            "ice_gathering": "complete",
        ]
    }
}
