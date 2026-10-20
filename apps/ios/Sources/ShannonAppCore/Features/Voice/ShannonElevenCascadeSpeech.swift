import Foundation

enum ShannonElevenCascadeSpeech {
    private static let characterTag = "[anime character]"
    private static let everydayStyle = "[anime character] [playfully] [energetically]"

    /// A secret or something said under the breath is whispered (owner 2026-10-20: 「ささやき声ができていなかった」).
    static func isSecret(_ text: String) -> Bool {
        text.range(of: #"(内緒|ないしょ|秘密|こっそり|ここだけの話|小声|耳打ち)"#, options: .regularExpression) != nil
    }

    static func style(for text: String, plan: ShannonVoicePlanDTO?) -> String {
        let actionReply = text.range(
            of: #"(実装|提案|任せ|作業|始め|進め|やって|試し|行きましょう)"#,
            options: .regularExpression
        ) != nil
        let secret = isSecret(text)
        guard let plan else {
            if secret { return "\(characterTag) [playfully] [whispers]" }
            if text.contains("ふふ") || text.contains("任せて") || text.contains("天才") {
                return everydayStyle
            }
            if text.contains("ありがとう") || text.contains("おかえり") || text.contains("！") {
                return "\(characterTag) [cheerfully] [energetically]"
            }
            return everydayStyle
        }
        let affect: String? = switch plan.affect {
        case .neutral: "[playfully]"
        case .bright, .happy, .fun, .relief, .pride, .gratitude, .hope, .content,
             .excited, .ecstatic, .triumphant:
            "[cheerfully]"
        case .playful, .giggle, .teasing, .mischievous, .plotting,
             .harmlessFalsehood, .selfDeprecating, .dramaticLament:
            "[playfully]"
        case .smug:
            "[smugly]"
        case .deadpan:
            "[confidently]"
        case .tender, .affectionate:
            actionReply ? "[cheerfully]" : "[reassuringly]"
        case .protective, .reassurance:
            "[confidently]"
        case .caring, .gentle, .quietCompanion:
            "[reassuringly]"
        case .serious, .focused, .determined, .cautious, .urgent, .retrying, .protectiveAnger,
             .blocked:
            "[confidently]"
        case .apologetic, .sad, .disappointed, .hurt, .anxious, .regret, .helpless, .lamenting:
            "[somberly]"
        case .curiosity, .surprised, .shocked, .stunned, .speechless, .confused:
            "[curiously]"
        case .shy, .blushing, .bashful, .flustered, .hidingHappiness,
             .jealous, .sulky, .leftOut:
            "[bashfully]"
        // Wanting him close (her 「デレデレ・甘えん坊」 region) sounds sweet.
        case .lonely, .attentionSeeking, .lightPossessive:
            "[sweetly]"
        case .cuteAngry, .annoyed, .indignant, .frustrated, .competitive,
             .seriousAnger, .panic, .scream:
            "[firmly]"
        case .sleepy:
            "[sleepy]"
        case .tired, .relaxed:
            "[calmly]"
        }
        let delivery: String? = switch plan.delivery {
        case .conversational: plan.affect == .neutral ? "[energetically]" : nil
        case .quick: "[briskly]"
        case .gentle: "[calmly]"
        case .focused: "[clearly]"
        case .energetic: "[energetically]"
        }
        var tags = [characterTag]
        if let affect { tags.append(affect) }
        // Close, quiet feelings (tender, her 「本気」, keeping him company, sleepy) are said softly when not hurried.
        let unhurried = plan.delivery == .gentle || plan.delivery == .conversational
        let expressiveDelivery: String? = if secret { "[whispers]" } else {
            switch plan.affect {
            case .bright, .happy, .fun, .playful, .giggle, .teasing, .mischievous,
                 .plotting, .smug, .excited, .ecstatic, .triumphant:
                "[energetically]"
            case .tender, .affectionate:
                actionReply ? "[energetically]" : unhurried ? "[softly]" : delivery
            case .protective, .reassurance:
                "[clearly]"
            case .quietCompanion, .sleepy:
                unhurried ? "[softly]" : delivery
            default: delivery
            }
        }
        if let expressiveDelivery, !tags.contains(expressiveDelivery) { tags.append(expressiveDelivery) }
        return tags.joined(separator: " ")
    }
}
