import Foundation

public enum ShannonVoiceEngine: String, Equatable, Sendable {
    case realtime
    case live
}

public enum ShannonVoiceParticipantMode: String, Codable, CaseIterable, Equatable, Sendable {
    case owner
    case guest

    public var japaneseName: String {
        switch self {
        case .owner: "本人だけ"
        case .guest: "友人も一緒"
        }
    }

    public var transcriptSpeakerName: String {
        switch self {
        case .owner: "あなた"
        case .guest: "参加者"
        }
    }

    public var allowsTranscriptPersistence: Bool { self == .owner }
    public var allowsCameraSharing: Bool { self == .owner }
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

public struct ShannonGeminiLiveSessionDTO: Codable, Equatable, Sendable {
    public let token: String
    public let model: String
    public let voice: String
    public let threadId: String
    public let instructions: String
    public let expiresAt: String
    public let inputUsdPerMinute: Double
    public let outputUsdPerMinute: Double

    public init(
        token: String,
        model: String,
        voice: String,
        threadId: String,
        instructions: String,
        expiresAt: String,
        inputUsdPerMinute: Double,
        outputUsdPerMinute: Double
    ) {
        self.token = token
        self.model = model
        self.voice = voice
        self.threadId = threadId
        self.instructions = instructions
        self.expiresAt = expiresAt
        self.inputUsdPerMinute = inputUsdPerMinute
        self.outputUsdPerMinute = outputUsdPerMinute
    }
}

public struct ShannonRealtimeVoiceAllowanceDTO: Codable, Equatable, Sendable {
    public let dayKey: String
    public let baseAllowanceSeconds: Int
    public let additionalAllowanceSeconds: Int
    public let totalAllowanceSeconds: Int
    public let reservedSeconds: Int
    public let remainingSeconds: Int
    public let maximumAllowanceSeconds: Int

    public init(
        dayKey: String,
        baseAllowanceSeconds: Int,
        additionalAllowanceSeconds: Int,
        totalAllowanceSeconds: Int,
        reservedSeconds: Int,
        remainingSeconds: Int,
        maximumAllowanceSeconds: Int
    ) {
        self.dayKey = dayKey
        self.baseAllowanceSeconds = baseAllowanceSeconds
        self.additionalAllowanceSeconds = additionalAllowanceSeconds
        self.totalAllowanceSeconds = totalAllowanceSeconds
        self.reservedSeconds = reservedSeconds
        self.remainingSeconds = remainingSeconds
        self.maximumAllowanceSeconds = maximumAllowanceSeconds
    }
}

public struct ShannonLiveVoiceDelegationRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String?
    public let transcript: String
    public let participantMode: ShannonVoiceParticipantMode
    public let deviceContext: ShannonVoiceDeviceContextDTO?

    public init(
        scopeKey: String,
        threadId: String?,
        transcript: String,
        participantMode: ShannonVoiceParticipantMode,
        deviceContext: ShannonVoiceDeviceContextDTO? = nil
    ) {
        self.scopeKey = scopeKey
        self.threadId = threadId
        self.transcript = transcript
        self.participantMode = participantMode
        self.deviceContext = deviceContext
    }
}

public struct ShannonVoiceDeviceLocationDTO: Codable, Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let accuracyMeters: Double
    public let observedAt: String

    public init(latitude: Double, longitude: Double, accuracyMeters: Double, observedAt: String) {
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
        self.observedAt = observedAt
    }
}

public struct ShannonVoiceDeviceContextDTO: Codable, Equatable, Sendable {
    public let timeZoneIdentifier: String
    public let requestedLocation: Bool
    public let location: ShannonVoiceDeviceLocationDTO?
    public var userUtterance: ShannonVoiceUserUtteranceDTO? = nil

    public init(
        timeZoneIdentifier: String,
        requestedLocation: Bool,
        location: ShannonVoiceDeviceLocationDTO?,
        userUtterance: ShannonVoiceUserUtteranceDTO? = nil
    ) {
        self.timeZoneIdentifier = timeZoneIdentifier
        self.requestedLocation = requestedLocation
        self.location = location
        self.userUtterance = userUtterance
    }
}

public struct ShannonVoiceUserUtteranceDTO: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
}

public enum ShannonVoiceConversationClassDTO: String, Codable, Equatable, Sendable {
    case noResponse = "no_response"
    case greeting
    case direct
    case skillSimple = "skill_simple"
    case skillComplex = "skill_complex"
}

public enum ShannonVoiceAffectDTO: String, Codable, Equatable, Sendable {
    case neutral, bright, playful, caring, serious, apologetic, excited
}

public enum ShannonVoiceDeliveryDTO: String, Codable, Equatable, Sendable {
    case conversational, quick, gentle, focused, energetic
}

public struct ShannonVoicePlanDTO: Codable, Equatable, Sendable {
    public let shouldRespond: Bool
    public let conversationClass: ShannonVoiceConversationClassDTO
    public let affect: ShannonVoiceAffectDTO
    public let delivery: ShannonVoiceDeliveryDTO
    public let selectedSkills: [String]
    public let decisionSource: String?
    public let decisionLatencyMilliseconds: Int?

    public init(
        shouldRespond: Bool,
        conversationClass: ShannonVoiceConversationClassDTO,
        affect: ShannonVoiceAffectDTO,
        delivery: ShannonVoiceDeliveryDTO,
        selectedSkills: [String] = [],
        decisionSource: String? = nil,
        decisionLatencyMilliseconds: Int? = nil
    ) {
        self.shouldRespond = shouldRespond
        self.conversationClass = conversationClass
        self.affect = affect
        self.delivery = delivery
        self.selectedSkills = selectedSkills
        self.decisionSource = decisionSource
        self.decisionLatencyMilliseconds = decisionLatencyMilliseconds
    }
}

public struct ShannonLiveVoiceDelegationResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let model: String
    public let reply: String
    public let organizeSession: ShannonOrganizeSessionDTO?
    public let voicePlan: ShannonVoicePlanDTO?

    public init(
        threadId: String,
        model: String,
        reply: String,
        organizeSession: ShannonOrganizeSessionDTO? = nil,
        voicePlan: ShannonVoicePlanDTO? = nil
    ) {
        self.threadId = threadId
        self.model = model
        self.reply = reply
        self.organizeSession = organizeSession
        self.voicePlan = voicePlan
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
    public var timeZone: String = TimeZone.current.identifier
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
