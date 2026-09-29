import Foundation

enum ShannonElevenCascadeSpeech {
    static func style(for text: String, plan: ShannonVoicePlanDTO?) -> String {
        guard let plan else {
            if text.contains("ふふ") || text.contains("任せて") || text.contains("天才") {
                return "[playful, lightly mischievous, quick conversational delivery]"
            }
            if text.contains("ありがとう") || text.contains("おかえり") || text.contains("！") {
                return "[bright, warm conversational voice, smiling tone]"
            }
            return "[warm, natural conversational voice]"
        }
        let affect: String = switch plan.affect {
        case .neutral: "warm, natural conversational voice"
        case .bright, .happy, .fun, .relief, .pride, .gratitude, .hope, .content,
             .excited, .ecstatic, .triumphant:
            "bright, warm conversational voice, smiling tone"
        case .playful, .giggle, .teasing, .mischievous, .plotting, .smug, .deadpan,
             .harmlessFalsehood, .selfDeprecating, .dramaticLament:
            "playful, lightly mischievous, quick conversational delivery"
        case .caring, .protective, .reassurance, .gentle, .quietCompanion, .tender, .affectionate:
            "gentle, close and reassuring"
        case .serious, .focused, .determined, .cautious, .urgent, .retrying, .protectiveAnger,
             .blocked:
            "focused, clear and sincere"
        case .apologetic, .sad, .disappointed, .hurt, .anxious, .regret, .helpless, .lamenting:
            "soft, sincere and slightly wistful"
        case .curiosity, .surprised, .shocked, .stunned, .speechless, .confused:
            "curious, lightly surprised"
        case .shy, .blushing, .bashful, .flustered, .hidingHappiness,
             .jealous, .sulky, .leftOut, .lonely, .attentionSeeking, .lightPossessive:
            "shy, warm and lightly playful"
        case .cuteAngry, .annoyed, .indignant, .frustrated, .competitive,
             .seriousAnger, .panic, .scream:
            "firm, clear and expressive without shouting"
        case .tired, .sleepy, .relaxed:
            "soft, relaxed and unhurried"
        }
        let delivery: String = switch plan.delivery {
        case .conversational: ""
        case .quick: "quick conversational delivery"
        case .gentle: "gentle pacing"
        case .focused: "crisp articulation"
        case .energetic: "lively pacing"
        }
        return "[\(affect)\(delivery.isEmpty || affect.contains(delivery) ? "" : ", \(delivery)")]"
    }
}
