import Foundation

enum ShannonElevenCascadeSpeech {
    private static let characterTag = "[anime character]"

    /// The acting tags after `[anime character]` at each strength (light, clear, strong). Every tag was played with her voice
    /// (eleven_v4_turbo, the same sentences with only the tag changed, 2026-10-26, shannon-desktop `voice-samples/emotion`) and
    /// changed the sound; [reassuringly] and [confidently] moved it no more than another seed, so they are not used. The owner then
    /// heard the old and the new tags blind (24 pairs, 2026-10-26) and each feeling has the one he chose: the bright feelings and smug
    /// keep their old lively reading, a plain neutral talk has none, apologetic, anxious and regret keep [somberly], cuteAngry keeps
    /// [firmly], curiosity keeps [curiously]. Nine in ten of her call turns are light (0.25), so light is the strength she had
    /// before and only a stronger feeling adds to it. The Windows app (`src/voice/speechStyle.ts`) has the same table, and both
    /// check it against the same cases (`ShannonElevenStyleCasesTests`).
    private struct Acting {
        let light: String
        let clear: String
        let strong: String

        init(_ light: String, _ clear: String? = nil, _ strong: String? = nil) {
            self.light = light
            self.clear = clear ?? light
            self.strong = strong ?? clear ?? light
        }

        func at(_ step: Int) -> String { step == 0 ? light : step == 1 ? clear : strong }
    }

    private static func acting(for affect: ShannonVoiceAffectDTO) -> Acting {
        switch affect {
        // A plain neutral talk is her character alone; a hurried, focused, gentle or lively one keeps its play (`style`).
        case .neutral: Acting("")
        case .bright, .happy, .hope, .fun:
            Acting("[cheerfully] [energetically]", "[cheerfully] [energetically]", "[excited] [energetically]")
        case .content, .gratitude, .relief, .pride: Acting("[cheerfully] [energetically]")
        case .excited, .ecstatic, .triumphant: Acting("[excited]", "[excited]", "[excited] [energetically]")
        case .playful, .giggle: Acting("[playfully] [energetically]")
        case .selfDeprecating, .dramaticLament: Acting("[playfully]")
        case .teasing, .mischievous, .plotting, .harmlessFalsehood: Acting("[mischievously]")
        case .smug: Acting("[smugly] [energetically]")
        case .deadpan: Acting("[deadpan]")
        case .shy, .blushing: Acting("[shyly]")
        case .bashful, .hidingHappiness: Acting("[bashfully]")
        case .flustered: Acting("[flustered]")
        // Sulking and jealousy sound apart from shyness (they shared [bashfully] before); a cute anger keeps its old [firmly].
        case .sulky, .jealous: Acting("[pouting]")
        case .cuteAngry: Acting("[firmly]")
        case .lonely, .leftOut: Acting("[wistfully]")
        // Wanting him close (her 「デレデレ・甘えん坊」 region) sounds sweet.
        case .attentionSeeking, .lightPossessive: Acting("[sweetly]")
        case .tender, .affectionate: Acting("[lovingly]")
        case .caring, .gentle, .quietCompanion: Acting("[gently]")
        case .reassurance: Acting("[calmly]")
        case .protective, .serious, .focused: Acting("[seriously]")
        case .sad, .hurt, .lamenting, .helpless: Acting("[sad]", "[sad]", "[tearfully]")
        case .disappointed: Acting("[disappointed]")
        case .apologetic, .regret, .anxious, .cautious: Acting("[somberly]")
        case .panic, .scream: Acting("[panicked]")
        case .annoyed: Acting("[annoyed]", "[annoyed]", "[angry]")
        case .frustrated, .blocked: Acting("[frustrated]", "[frustrated]", "[angry]")
        case .indignant: Acting("[indignantly]", "[indignantly]", "[angry]")
        case .competitive: Acting("[determined] [energetically]")
        // A real anger is low and cold, never shouted; anger for his sake raises its voice once it is clear.
        case .seriousAnger: Acting("[coldly]")
        case .protectiveAnger: Acting("[seriously]", "[angry]")
        case .surprised: Acting("[surprised]", "[surprised]", "[shocked]")
        case .shocked, .stunned, .speechless: Acting("[shocked]")
        case .confused: Acting("[confused]")
        case .curiosity: Acting("[curiously]")
        case .determined, .retrying: Acting("[determined]")
        case .urgent: Acting("[urgently]")
        case .sleepy: Acting("[sleepy]")
        case .tired: Acting("[tired]")
        case .relaxed: Acting("[calmly]")
        }
    }

    /// Close, quiet feelings (tender, her 「本気」, keeping him company, sleepy) are said softly when not hurried.
    private static let softAffects: Set<ShannonVoiceAffectDTO> = [.tender, .affectionate, .quietCompanion, .sleepy]
    /// A low or quiet acting gets no drive added to it.
    private static let quietTags: Set<String> = [
        "[sad]", "[tearfully]", "[disappointed]", "[wistfully]", "[somberly]", "[sleepy]", "[tired]", "[calmly]",
        "[pouting]", "[shyly]", "[bashfully]", "[worried]", "[coldly]", "[deadpan]", "[gently]", "[lovingly]",
    ]
    /// A heated acting gets no calm added to it.
    private static let heatedTags: Set<String> = ["[excited]", "[panicked]", "[angry]", "[urgently]"]

    /// The strength step: below 0.45 light, below 0.75 clear, else strong.
    static func actingStep(_ intensity: Double) -> Int {
        intensity < 0.45 ? 0 : intensity < 0.75 ? 1 : 2
    }

    /// A secret or something said under the breath is whispered (owner 2026-10-20: 「ささやき声ができていなかった」).
    static func isSecret(_ text: String) -> Bool {
        text.range(of: #"(内緒|ないしょ|秘密|こっそり|ここだけの話|小声|耳打ち)"#, options: .regularExpression) != nil
    }

    static func style(for text: String, plan: ShannonVoicePlanDTO?) -> String {
        // A whisper lasts longer with no other acting tag beside it (her voice, 2026-10-20); the server asks it again each 「、」.
        if isSecret(text) { return "\(characterTag) [whispers]" }
        // A sentence with no plan (a touch line, the earphone) adds only what its words show.
        guard let plan else {
            if text.range(of: #"(ふふ|任せて|天才)"#, options: .regularExpression) != nil {
                return "\(characterTag) [playfully] [energetically]"
            }
            if text.range(of: #"(ありがとう|おかえり|！)"#, options: .regularExpression) != nil {
                return "\(characterTag) [cheerfully] [energetically]"
            }
            return characterTag
        }
        // Taking up something he asked for sounds lively even when the feeling is tender.
        let actionReply = text.range(
            of: #"(実装|提案|任せ|作業|始め|進め|やって|試し|行きましょう)"#,
            options: .regularExpression
        ) != nil
        if (plan.affect == .tender || plan.affect == .affectionate) && actionReply {
            return "\(characterTag) [cheerfully] [energetically]"
        }
        // A neutral reply that is hurried, focused, gentle or lively keeps its play (the owner chose it for 「すぐやるね」).
        let shown = plan.affect == .neutral && plan.delivery != .conversational
            ? "[playfully]" : acting(for: plan.affect).at(actingStep(plan.affectIntensity ?? 0.5))
        var tags = [characterTag] + shown.split(separator: " ").map(String.init)
        let unhurried = plan.delivery == .gentle || plan.delivery == .conversational
        let delivery: String?
        if softAffects.contains(plan.affect) && unhurried {
            delivery = "[softly]"
        } else {
            delivery = switch plan.delivery {
            case .conversational: nil
            case .quick: "[briskly]"
            case .gentle: "[calmly]"
            case .focused: "[clearly]"
            case .energetic: "[energetically]"
            }
        }
        let quiet = tags.contains { quietTags.contains($0) }
        let heated = tags.contains { heatedTags.contains($0) }
        if let delivery, tags.count < 3, !tags.contains(delivery),
           !(quiet && (delivery == "[energetically]" || delivery == "[briskly]")),
           !(heated && (delivery == "[calmly]" || delivery == "[softly]")) {
            tags.append(delivery)
        }
        return tags.joined(separator: " ")
    }
}
