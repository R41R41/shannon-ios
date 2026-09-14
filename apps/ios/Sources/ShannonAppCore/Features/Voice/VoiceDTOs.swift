import Foundation

public enum ShannonVoiceEngine: String, Equatable, Sendable {
    case realtime
    case live
}

public struct ShannonRealtimeVoiceCallDTO: Equatable, Sendable {
    public let answerSDP: String
    public let threadID: String
    public let engine: ShannonVoiceEngine
    public let model: String?
    public let callID: String?
    public let dailyRemainingSeconds: Int?

    public init(
        answerSDP: String,
        threadID: String,
        engine: ShannonVoiceEngine = .realtime,
        model: String? = nil,
        callID: String? = nil,
        dailyRemainingSeconds: Int? = nil
    ) {
        self.answerSDP = answerSDP
        self.threadID = threadID
        self.engine = engine
        self.model = model
        self.callID = callID
        self.dailyRemainingSeconds = dailyRemainingSeconds
    }
}

public struct ShannonLiveVoiceDelegationRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String?
    public let transcript: String

    public init(scopeKey: String, threadId: String?, transcript: String) {
        self.scopeKey = scopeKey
        self.threadId = threadId
        self.transcript = transcript
    }
}

public struct ShannonLiveVoiceDelegationResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let model: String
    public let reply: String

    public init(threadId: String, model: String, reply: String) {
        self.threadId = threadId
        self.model = model
        self.reply = reply
    }
}

public struct ShannonVoiceVisionResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let model: String
    public let description: String

    public init(threadId: String, model: String, description: String) {
        self.threadId = threadId
        self.model = model
        self.description = description
    }
}

public enum ShannonVoiceIdentityModeDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case automatic
    case manual

    public var japaneseName: String {
        switch self {
        case .automatic: "シャノンに任せる"
        case .manual: "自分で選ぶ"
        }
    }
}

public struct ShannonVoiceCandidateDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct ShannonVoiceIdentityPreferenceDTO: Codable, Equatable, Sendable {
    public let mode: ShannonVoiceIdentityModeDTO
    public let selectedVoice: String?
    public let effectiveVoice: String
    public let updatedAt: String?

    public init(
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?,
        effectiveVoice: String,
        updatedAt: String?
    ) {
        self.mode = mode
        self.selectedVoice = selectedVoice
        self.effectiveVoice = effectiveVoice
        self.updatedAt = updatedAt
    }
}

public struct ShannonVoiceIdentityResponseDTO: Codable, Equatable, Sendable {
    public let preference: ShannonVoiceIdentityPreferenceDTO
    public let candidates: [ShannonVoiceCandidateDTO]

    public init(
        preference: ShannonVoiceIdentityPreferenceDTO,
        candidates: [ShannonVoiceCandidateDTO]
    ) {
        self.preference = preference
        self.candidates = candidates
    }
}

public struct ShannonVoiceIdentityUpdateRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let mode: ShannonVoiceIdentityModeDTO
    public let selectedVoice: String?

    public init(scopeKey: String, mode: ShannonVoiceIdentityModeDTO, selectedVoice: String?) {
        self.scopeKey = scopeKey
        self.mode = mode
        self.selectedVoice = selectedVoice
    }
}

public struct ShannonVoicePreviewRequestDTO: Codable, Equatable, Sendable {
    public let voice: String

    public init(voice: String) {
        self.voice = voice
    }
}

public struct ShannonRealtimeVoiceTurnRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String?
    public let userTranscript: String
    public let shannonTranscript: String
}

public struct ShannonRealtimeVoiceTurnResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let messageEmotion: ShannonMessageEmotionDTO
    public let state: CompanionStateDTO
}
