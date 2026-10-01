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
        case .guest: "話し手"
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
    /// `openai` for the Realtime transcription session. An old server omits it and replies with a
    /// Gemini token this build cannot use, so the client rejects a missing or different value.
    public let transcriptionProvider: String?

    public init(
        token: String,
        model: String,
        voice: String,
        threadId: String,
        instructions: String,
        expiresAt: String,
        inputUsdPerMinute: Double,
        outputUsdPerMinute: Double,
        transcriptionProvider: String? = nil
    ) {
        self.token = token
        self.model = model
        self.voice = voice
        self.threadId = threadId
        self.instructions = instructions
        self.expiresAt = expiresAt
        self.inputUsdPerMinute = inputUsdPerMinute
        self.outputUsdPerMinute = outputUsdPerMinute
        self.transcriptionProvider = transcriptionProvider
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
    public let source: ShannonVoiceUtteranceSource?
    public let rawText: String?
    /// Only for 「友人も一緒」: this call's own earlier turns. Omitted for owner turns.
    public let callContext: ShannonVoiceCallContextDTO?
    /// Owner mode only: the owner said someone may be with him and the call was not switched.
    public let companionPresent: Bool?

    public init(
        id: String, text: String, source: ShannonVoiceUtteranceSource? = nil, rawText: String? = nil,
        callContext: ShannonVoiceCallContextDTO? = nil, companionPresent: Bool? = nil
    ) {
        self.id = id
        self.text = text
        self.source = source
        self.rawText = rawText
        self.callContext = callContext
        self.companionPresent = companionPresent
    }
}

public enum ShannonVoiceConversationClassDTO: String, Codable, Equatable, Sendable {
    case noResponse = "no_response"
    case greeting
    case direct
    case skillSimple = "skill_simple"
    case skillComplex = "skill_complex"
}

public enum ShannonVoiceAffectDTO: String, Codable, Equatable, Sendable {
    case neutral, bright, playful, serious
    case happy, fun, excited, ecstatic, relief, pride, gratitude, hope, curiosity, affectionate
    case giggle, teasing, mischievous, plotting, smug, deadpan, harmlessFalsehood, selfDeprecating, dramaticLament
    case shy, blushing, bashful, flustered, hidingHappiness
    case cuteAngry, seriousAnger, annoyed, indignant, frustrated, competitive, protectiveAnger
    case jealous, sulky, leftOut, lonely, attentionSeeking, lightPossessive, reassurance
    case sad, disappointed, hurt, anxious, regret, helpless, lamenting, caring, protective
    case surprised, shocked, stunned, speechless, confused, panic, scream
    case focused, determined, cautious, urgent, blocked, retrying, triumphant, tired, sleepy
    case gentle, relaxed, content, quietCompanion, tender, apologetic
}

public enum ShannonVoiceDeliveryDTO: String, Codable, Equatable, Sendable {
    case conversational, quick, gentle, focused, energetic
}

public enum ShannonVoiceLatencyClassDTO: String, Codable, Equatable, Sendable {
    case underOneSecond = "under_1s"
    case underThreeSeconds = "under_3s"
    case underTenSeconds = "under_10s"
    case overTenSeconds = "over_10s"
}

public struct ShannonVoicePlanDTO: Codable, Equatable, Sendable {
    public let shouldRespond: Bool
    public let replyRequiredProbability: Double?
    public let solutionWantedProbability: Double?
    public let conversationClass: ShannonVoiceConversationClassDTO
    public let latencyClass: ShannonVoiceLatencyClassDTO?
    public let affect: ShannonVoiceAffectDTO
    public let affectIntensity: Double?
    public let delivery: ShannonVoiceDeliveryDTO
    public let selectedSkills: [String]
    public let skillScores: [String: Double]?
    public let waitingPhrase: String?
    public let decisionSource: String?
    public let decisionLatencyMilliseconds: Int?
    /// The face of the emotion this turn's voice acts with. Text, so a newer server's value never fails decoding.
    public var expression: String? = nil
    public var feeling: String? = nil

    public init(
        shouldRespond: Bool,
        replyRequiredProbability: Double? = nil,
        solutionWantedProbability: Double? = nil,
        conversationClass: ShannonVoiceConversationClassDTO,
        latencyClass: ShannonVoiceLatencyClassDTO? = nil,
        affect: ShannonVoiceAffectDTO,
        affectIntensity: Double? = nil,
        delivery: ShannonVoiceDeliveryDTO,
        selectedSkills: [String] = [],
        skillScores: [String: Double]? = nil,
        waitingPhrase: String? = nil,
        decisionSource: String? = nil,
        decisionLatencyMilliseconds: Int? = nil
    ) {
        self.shouldRespond = shouldRespond
        self.replyRequiredProbability = replyRequiredProbability
        self.solutionWantedProbability = solutionWantedProbability
        self.conversationClass = conversationClass
        self.latencyClass = latencyClass
        self.affect = affect
        self.affectIntensity = affectIntensity
        self.delivery = delivery
        self.selectedSkills = selectedSkills
        self.skillScores = skillScores
        self.waitingPhrase = waitingPhrase
        self.decisionSource = decisionSource
        self.decisionLatencyMilliseconds = decisionLatencyMilliseconds
    }
}

public struct ShannonLiveVoiceDelegationResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let model: String
    public let reply: String
    public let organizeSession: ShannonOrganizeSessionDTO?
    public let uiBlocks: [ShannonUIBlockDTO]?
    public let voicePlan: ShannonVoicePlanDTO?
    public let voiceMetrics: ShannonVoiceServerMetricsDTO?
    /// The server answered this owner turn as if someone else may be listening.
    public var companionPresent: Bool? = nil

    public init(
        threadId: String,
        model: String,
        reply: String,
        organizeSession: ShannonOrganizeSessionDTO? = nil,
        uiBlocks: [ShannonUIBlockDTO]? = nil,
        voicePlan: ShannonVoicePlanDTO? = nil,
        voiceMetrics: ShannonVoiceServerMetricsDTO? = nil
    ) {
        self.threadId = threadId
        self.model = model
        self.reply = reply
        self.organizeSession = organizeSession
        self.uiBlocks = uiBlocks
        self.voicePlan = voicePlan
        self.voiceMetrics = voiceMetrics
    }
}

public struct ShannonVoiceServerMetricsDTO: Codable, Equatable, Sendable {
    public let decisionMilliseconds: Int
    public let contextMilliseconds: Int
    public let firstModelTokenMilliseconds: Int
    public let modelCompleteMilliseconds: Int
    public let turnToModelCompleteMilliseconds: Int?
}

public enum ShannonLiveVoiceStreamEventTypeDTO: String, Codable, Equatable, Sendable {
    case plan
    case segment
    case completed
    case error
}

public struct ShannonLiveVoiceStreamEventDTO: Codable, Equatable, Sendable {
    public let type: ShannonLiveVoiceStreamEventTypeDTO
    public let text: String?
    public let voicePlan: ShannonVoicePlanDTO?
    public let response: ShannonLiveVoiceDelegationResponseDTO?
    public let status: Int?
}

public typealias ShannonVoiceSegmentHandler = @MainActor @Sendable (
    _ text: String,
    _ voicePlan: ShannonVoicePlanDTO?
) async -> Void

public typealias ShannonVoiceStreamingDelegation = @MainActor (
    _ text: String,
    _ utterance: ShannonVoiceUserUtteranceDTO?,
    _ participantMode: ShannonVoiceParticipantMode,
    _ onSegment: ShannonVoiceSegmentHandler
) async throws -> ShannonLiveVoiceDelegationResponseDTO

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
    /// The reconciled emotion the voice acted with, so the stored face equals the call Eye.
    public var emotion: ShannonVoiceTurnEmotionDTO? = nil
    /// Someone else may have been listening: the turn is kept but teaches nothing about the owner.
    public var companionPresent: Bool? = nil
}

public struct ShannonVoiceTurnEmotionDTO: Codable, Equatable, Sendable {
    public let primary: String
    public let intensity: Double

    public init(primary: String, intensity: Double) {
        self.primary = primary
        self.intensity = intensity
    }
}

public extension ShannonVoicePlanDTO {
    /// Nil from a server that predates the face, or for a face this build does not know.
    var face: ShannonFace? {
        expression.flatMap(ShannonExpressionDTO.init(rawValue:)).map { ShannonFace(expression: $0, feelingName: feeling) }
    }

    var turnEmotion: ShannonVoiceTurnEmotionDTO {
        ShannonVoiceTurnEmotionDTO(primary: affect.rawValue, intensity: affectIntensity ?? 0.5)
    }
}

public struct ShannonRealtimeVoiceTurnResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let messageEmotion: ShannonMessageEmotionDTO
    public let state: CompanionStateDTO
    public var turnId: String?
}
