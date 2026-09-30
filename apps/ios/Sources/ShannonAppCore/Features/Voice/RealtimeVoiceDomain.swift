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

    var dialogueActivity: ShannonDialogueActivity {
        switch self {
        case .idle: .idle
        case .requestingPermission: .preparing
        case .connecting: .connecting
        case .listening: .listening
        case .thinking: .thinking
        case .speaking: .speaking
        case .failed: .failed
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

public enum ShannonVoiceInputPreference: String, CaseIterable, Identifiable, Sendable {
    case automatic
    case builtIn
    case connected

    public var id: String { rawValue }

    public var japaneseLabel: String {
        switch self {
        case .automatic: "自動"
        case .builtIn: "iPhoneのマイク"
        case .connected: "イヤホン／外部マイク"
        }
    }

    public var systemImage: String {
        switch self {
        case .automatic: "wand.and.rays"
        case .builtIn: "iphone"
        case .connected: "headphones"
        }
    }
}

public struct ShannonVoiceInputState: Equatable, Sendable {
    public let preference: ShannonVoiceInputPreference
    public let activeInputName: String?
    public let isBuiltInAvailable: Bool
    public let isConnectedInputAvailable: Bool
    /// The saved choice is not connected, so this call uses automatic routing.
    public let isPreferenceUnavailable: Bool

    public init(
        preference: ShannonVoiceInputPreference = .automatic,
        activeInputName: String? = nil,
        isBuiltInAvailable: Bool = true,
        isConnectedInputAvailable: Bool = false,
        isPreferenceUnavailable: Bool = false
    ) {
        self.preference = preference
        self.activeInputName = activeInputName
        self.isBuiltInAvailable = isBuiltInAvailable
        self.isConnectedInputAvailable = isConnectedInputAvailable
        self.isPreferenceUnavailable = isPreferenceUnavailable
    }

    public var activeInputLabel: String {
        guard let activeInputName else { return "入力を確認中" }
        guard isPreferenceUnavailable else { return "使用中: \(activeInputName)" }
        return "使用中: \(activeInputName)（\(preference.japaneseLabel)が未接続）"
    }

    public func canSelect(_ preference: ShannonVoiceInputPreference) -> Bool {
        switch preference {
        case .automatic: true
        case .builtIn: isBuiltInAvailable
        case .connected: isConnectedInputAvailable
        }
    }
}

public enum ShannonRealtimeVoiceTextError: Error, Equatable, Sendable {
    case emptyMessage
    case sessionUnavailable
    case sessionEnded
}

public enum ShannonRealtimeVoiceCameraError: Error, Equatable, Sendable {
    case sessionUnavailable
    case sessionEnded
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
    case correlated(ShannonRealtimePacket)
    case sessionReady
    case speechStarted
    case speechStopped
    case inputTranscriptDelta(String)
    case inputTranscriptDone(String)
    case outputTranscriptDelta(String)
    case outputTranscriptDone(String)
    case responseStarted
    case responseFinished(ShannonRealtimeVoiceUsage?)
    case realtimeFunctionCall(callID: String, request: String)
    case liveInputTranscriptDelta(String, startMilliseconds: Int, endMilliseconds: Int)
    case liveOutputTranscriptDelta(String, startMilliseconds: Int, endMilliseconds: Int)
    case liveDelegationRequested(id: String, offsetMilliseconds: Int)
    case liveUsageUpdated(seconds: Double)
    case liveSessionClosed(reason: String?)
    case failed(String?)

    public static func decode(_ data: Data) -> Self? {
        guard let value = try? JSONSerialization.jsonObject(with: data),
              let object = value as? [String: Any],
              let type = object["type"] as? String else { return nil }
        if let packet = ShannonRealtimePacket.decode(object, type: type) { return .correlated(packet) }
        switch type {
        case "session.created", "session.updated", "session.started": return .sessionReady
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
        case "response.function_call_arguments.done":
            guard object["name"] as? String == "consult_shannon_backend",
                  let callID = object["call_id"] as? String,
                  !callID.isEmpty,
                  let arguments = object["arguments"] as? String,
                  let argumentData = arguments.data(using: .utf8),
                  let argumentObject = (try? JSONSerialization.jsonObject(with: argumentData)) as? [String: Any],
                  let request = argumentObject["request"] as? String,
                  !request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return .realtimeFunctionCall(
                callID: callID,
                request: String(request.trimmingCharacters(in: .whitespacesAndNewlines).prefix(8_000))
            )
        case "session.input_transcript.delta":
            return .liveInputTranscriptDelta(
                object["delta"] as? String ?? "",
                startMilliseconds: integer(object["start_ms"]),
                endMilliseconds: integer(object["end_ms"])
            )
        case "session.output_transcript.delta":
            return .liveOutputTranscriptDelta(
                object["delta"] as? String ?? "",
                startMilliseconds: integer(object["start_ms"]),
                endMilliseconds: integer(object["end_ms"])
            )
        case "session.delegation.created":
            let delegation = object["delegation"] as? [String: Any]
            guard delegation?["target"] as? String == "client",
                  let id = delegation?["id"] as? String,
                  !id.isEmpty else { return nil }
            return .liveDelegationRequested(
                id: id,
                offsetMilliseconds: integer(object["offset_ms"])
            )
        case "session.usage.updated":
            let usage = object["usage"] as? [String: Any]
            return .liveUsageUpdated(seconds: number(usage?["seconds"]))
        case "session.closed":
            return .liveSessionClosed(reason: object["reason"] as? String)
        case "error":
            let error = object["error"] as? [String: Any]
            let code = error?["code"] as? String ?? error?["type"] as? String
            return .failed(code)
        default: return nil
        }
    }

    private static func integer(_ value: Any?) -> Int {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        return 0
    }

    private static func number(_ value: Any?) -> Double {
        if let value = value as? Double { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        return 0
    }

    static func decodeUsage(_ value: Any?) -> ShannonRealtimeVoiceUsage? {
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
    private var liveSpeaker: LiveSpeaker?

    private enum LiveSpeaker: Equatable, Sendable {
        case user
        case shannon
    }

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
        case .liveInputTranscriptDelta(let delta, _, _):
            let completed = liveSpeaker == .shannon ? pendingLiveTurn() : nil
            if liveSpeaker == .shannon {
                userText = ""
                shannonText = ""
            }
            liveSpeaker = .user
            userText += delta
            if let completed { return completed }
        case .liveOutputTranscriptDelta(let delta, _, _):
            liveSpeaker = .shannon
            shannonText += delta
        default:
            break
        }
        guard !completedUserText.isEmpty, !completedShannonText.isEmpty else { return nil }
        let turn = (completedUserText, completedShannonText)
        completedUserText = ""
        completedShannonText = ""
        return turn
    }

    public mutating func flushPendingLiveTurn() -> (user: String, shannon: String)? {
        guard let turn = pendingLiveTurn() else { return nil }
        userText = ""
        shannonText = ""
        liveSpeaker = nil
        return turn
    }

    public mutating func beginTypedUserTurn(_ text: String) -> (user: String, shannon: String)? {
        let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedText.isEmpty else { return nil }
        let completed = pendingLiveTurn()
        userText = normalizedText
        shannonText = ""
        completedUserText = normalizedText
        completedShannonText = ""
        liveSpeaker = .user
        return completed
    }

    public var delegationTranscript: String {
        userText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func pendingLiveTurn() -> (user: String, shannon: String)? {
        let user = userText.trimmingCharacters(in: .whitespacesAndNewlines)
        let shannon = shannonText.trimmingCharacters(in: .whitespacesAndNewlines)
        return user.isEmpty || shannon.isEmpty ? nil : (user, shannon)
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
