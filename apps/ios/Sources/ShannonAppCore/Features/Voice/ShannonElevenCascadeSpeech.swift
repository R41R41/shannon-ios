import Foundation

enum ShannonElevenCascadeSpeech {
    private static let characterTag = "[anime character]"

    static func style(for text: String, plan: ShannonVoicePlanDTO?) -> String {
        guard let plan else {
            if text.contains("ふふ") || text.contains("任せて") || text.contains("天才") {
                return "\(characterTag) [mischievously]"
            }
            if text.contains("ありがとう") || text.contains("おかえり") || text.contains("！") {
                return "\(characterTag) [cheerfully]"
            }
            return characterTag
        }
        let affect: String? = switch plan.affect {
        case .neutral: nil
        case .bright, .happy, .fun, .relief, .pride, .gratitude, .hope, .content,
             .excited, .ecstatic, .triumphant:
            "[cheerfully]"
        case .playful, .giggle, .teasing, .mischievous, .plotting, .smug, .deadpan,
             .harmlessFalsehood, .selfDeprecating, .dramaticLament:
            "[mischievously]"
        case .caring, .protective, .reassurance, .gentle, .quietCompanion, .tender, .affectionate:
            "[reassuringly]"
        case .serious, .focused, .determined, .cautious, .urgent, .retrying, .protectiveAnger,
             .blocked:
            "[confidently]"
        case .apologetic, .sad, .disappointed, .hurt, .anxious, .regret, .helpless, .lamenting:
            "[somberly]"
        case .curiosity, .surprised, .shocked, .stunned, .speechless, .confused:
            "[curiously]"
        case .shy, .blushing, .bashful, .flustered, .hidingHappiness,
             .jealous, .sulky, .leftOut, .lonely, .attentionSeeking, .lightPossessive:
            "[bashfully]"
        case .cuteAngry, .annoyed, .indignant, .frustrated, .competitive,
             .seriousAnger, .panic, .scream:
            "[firmly]"
        case .tired, .sleepy, .relaxed:
            "[calmly]"
        }
        let delivery: String? = switch plan.delivery {
        case .conversational: nil
        case .quick: "[briskly]"
        case .gentle: "[calmly]"
        case .focused: "[clearly]"
        case .energetic: "[energetically]"
        }
        var tags = [characterTag]
        if let affect { tags.append(affect) }
        if let delivery, !tags.contains(delivery) { tags.append(delivery) }
        return tags.joined(separator: " ")
    }
}
