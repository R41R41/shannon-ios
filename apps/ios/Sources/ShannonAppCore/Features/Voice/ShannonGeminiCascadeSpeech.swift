import Foundation

enum ShannonGeminiCascadeSpeech {
    static let baseStyle = """
    明るく快活で、声に笑顔を含んだ軽快なアニメ会話。少し速めの弾むテンポ、活発な抑揚、歯切れのよい語尾。生意気で悪戯っぽいが愛嬌があり、感情の変化をはっきり演じる。叫ばず、落ち着きすぎず、自然な小さな笑いを時々こぼす。
    """

    static func style(for text: String) -> String {
        let direction: String
        if text.range(of: #"(ありがとう|嬉し|やった|最高|よし|！|!)"#, options: .regularExpression) != nil {
            direction = "声に笑顔を含め、明るく弾むテンポと軽やかな音程変化で話す。"
        } else if text.range(of: #"(当然|天才|任せて|できます|余裕)"#, options: .regularExpression) != nil {
            direction = "自信たっぷりに歯切れよく、少し生意気で楽しげな得意顔が伝わるように話す。"
        } else if text.range(of: #"(べ、別に|ちがう|違う|照れ|恥ずか|好きじゃ)"#, options: .regularExpression) != nil {
            direction = "一瞬テンポを乱し、強がりの奥から照れと慌てが漏れるように話す。"
        } else if text.range(of: #"(もう|まったく|困ります|ダメ|だめ|嫌)"#, options: .regularExpression) != nil {
            direction = "叫ばず、短く鋭い語尾と小気味よいテンポで不満を表す。"
        } else if text.range(of: #"(大丈夫|心配|気をつけ|無理しない)"#, options: .regularExpression) != nil {
            direction = "テンポを落とし、相手を気遣う真剣さと優しさを込めて話す。"
        } else if text.range(of: #"(ごめん|悲し|寂し|残念)"#, options: .regularExpression) != nil {
            direction = "息をわずかに含め、崩れすぎない繊細な悲しみとして話す。"
        } else if text.range(of: #"(好き|そばに|一緒に|おかえり|おやすみ)"#, options: .regularExpression) != nil {
            direction = "声量を少し落とし、近く温かい声で素直な好意が伝わるように話す。"
        } else {
            direction = "自然な会話の調子で、前後の文となめらかにつなげる。"
        }
        return String("\(baseStyle) \(direction)".prefix(500))
    }

    static func style(for text: String, plan: ShannonVoicePlanDTO?) -> String {
        guard let plan else { return style(for: text) }
        let affect: String = switch plan.affect {
        case .neutral: "自然で気取らない感情。"
        case .bright: "声に笑顔を含む明るさ。"
        case .playful: "愛嬌のある軽い悪戯っぽさ。"
        case .caring: "相手を気遣う近く温かな声。"
        case .serious: "落ち着いた真剣さ。"
        case .apologetic: "誠実で繊細な申し訳なさ。"
        case .excited: "弾む喜びと高揚感。"
        }
        let delivery: String = switch plan.delivery {
        case .conversational: "自然な会話のテンポで。"
        case .quick: "短く軽快に、急かさず。"
        case .gentle: "少しゆっくり、柔らかく。"
        case .focused: "明瞭で歯切れよく、事実を聞き取りやすく。"
        case .energetic: "生き生きしたテンポと抑揚で、叫ばずに。"
        }
        return String("明るく自然な日本語の会話。\(affect) \(delivery)".prefix(500))
    }

    static func segments(_ text: String) -> [String] {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return [] }
        var result: [String] = []
        var current = ""
        for character in value {
            current.append(character)
            if "。！？!?\n".contains(character) {
                let segment = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !segment.isEmpty { result.append(segment) }
                current = ""
            }
        }
        let remainder = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !remainder.isEmpty { result.append(remainder) }
        return result
    }

    static func finalizeDelayMilliseconds(for text: String, turnComplete: Bool) -> Int {
        if turnComplete { return 0 }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.range(of: #"[。！？!?][」』）】”\"]?$"#, options: .regularExpression) != nil { return 80 }
        if value.range(of: #"(?:[、…]|けど|から|ので|でも|だが|ながら|つつ)$"#, options: .regularExpression) != nil { return 420 }
        return value.count <= 3 ? 360 : 220
    }
}
