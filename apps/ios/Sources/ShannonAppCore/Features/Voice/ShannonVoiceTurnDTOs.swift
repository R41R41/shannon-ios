import Foundation

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
    public var reactionId: String? = nil
    public var feedbackRecordId: String? = nil
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
    /// Nil from a server that predates the face, or for a face this build does not know (`uncomfortable` is `annoyed`).
    var face: ShannonFace? {
        expression.flatMap(ShannonExpressionDTO.known).map { ShannonFace(expression: $0, feelingName: feeling, kindName: kind) }
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
    public var feedback: ShannonFeedbackDTO? = nil
}
