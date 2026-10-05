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
        case .bright, .happy, .fun, .relief, .pride, .gratitude, .hope, .content:
            "声に笑顔を含む自然な明るさ。"
        case .playful, .giggle, .teasing, .mischievous, .plotting, .smug, .deadpan,
             .harmlessFalsehood, .selfDeprecating, .dramaticLament:
            "愛嬌のある軽い悪戯っぽさ。冗談はすぐ分かる調子で。"
        case .caring, .protective, .reassurance, .gentle, .quietCompanion, .tender, .affectionate:
            "相手を気遣う近く温かな声。"
        case .serious, .focused, .determined, .cautious, .urgent, .retrying, .protectiveAnger:
            "落ち着いた真剣さと、明瞭な意志。"
        case .apologetic: "誠実で繊細な申し訳なさ。"
        case .excited, .ecstatic, .triumphant: "弾む喜びと高揚感。"
        case .curiosity: "答えを楽しみにする好奇心。"
        case .shy, .blushing, .bashful, .flustered, .hidingHappiness:
            "少しテンポを乱し、嬉しさの奥に照れがにじむ声。"
        case .cuteAngry, .annoyed, .indignant, .frustrated, .competitive:
            "怖くならない短い語尾で、可愛い反発や悔しさを表す。"
        case .seriousAnger:
            "叫ばず、低めの重心と明瞭な語尾で正当な怒りを表す。"
        case .jealous, .sulky, .leftOut, .lonely, .attentionSeeking, .lightPossessive:
            "責めずに、少しだけ拗ねた近い声。罪悪感を与えない。"
        case .sad, .disappointed, .hurt, .anxious, .regret, .helpless, .lamenting:
            "息をわずかに含め、崩れすぎない繊細な悲しみや心配。"
        case .surprised, .shocked, .stunned, .speechless, .confused:
            "一瞬だけ間と音程変化を大きくして驚きを表す。"
        case .panic, .scream:
            "短い強い驚きとして演じ、叫び続けない。"
        case .blocked:
            "少し悔しさを含めつつ、状況を正直に説明する声。"
        case .tired, .sleepy, .relaxed:
            "テンポと声量を少し落とした穏やかな声。"
        }
        let delivery: String = switch plan.delivery {
        case .conversational: "自然な会話のテンポで。"
        case .quick: "短く軽快に、急かさず。"
        case .gentle: "少しゆっくり、柔らかく。"
        case .focused: "明瞭で歯切れよく、事実を聞き取りやすく。"
        case .energetic: "生き生きしたテンポと抑揚で、叫ばずに。"
        }
        let intensity = switch plan.affectIntensity ?? 0.5 {
        case ..<0.4: "感情はごく自然ににじませる程度に。"
        case 0.4..<0.75: "感情をはっきり伝えるが、内容を邪魔しない強さで。"
        default: "この瞬間にふさわしい強い感情を、わざとらしくならない範囲で明確に。"
        }
        return String("明るく自然な日本語の会話。\(affect) \(intensity) \(delivery)".prefix(500))
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

    static func spokenText(for displayText: String) -> String {
        let pronunciations = [
            ("Aether", "エーテル"), ("Voyager", "ボイジャー"), ("Syzygy", "シジジー"),
            ("Jev", "ジェブ"), ("Minebot", "マインボット"), ("Codex", "コーデックス"),
            ("SwiftUI", "スウィフトユーアイ"), ("TestFlight", "テストフライト"),
        ]
        var spoken = pronunciations.reduce(displayText) { value, pronunciation in
            value.replacingOccurrences(of: pronunciation.0, with: pronunciation.1)
        }
        for kaomoji in ["（^人^）", "(^人^)", "੧(❛□❛✿)"] {
            spoken = spoken.replacingOccurrences(of: kaomoji, with: "")
        }
        spoken = String(spoken.filter { character in
            !character.unicodeScalars.contains { $0.properties.isEmojiPresentation }
        })
        spoken = spoken.replacingOccurrences(
            of: #"(?:\^人\^|❛[^\n]{0,8}✿|\(笑\)|ｗ{2,})"#,
            with: "",
            options: .regularExpression
        )
        spoken = spoken.replacingOccurrences(of: #"笑(?=[。！？!?\s]|$)"#, with: "ふふっ", options: .regularExpression)
        return spoken.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

}

@MainActor
final class ShannonGeminiStreamingSpeechCoordinator {
    typealias StreamSpeech = @MainActor (String, String?) async throws -> ShannonGeminiSpeechStream
    /// The speech of one sentence and its display text, so the sentence is known when it plays.
    typealias ConsumeSpeech = @MainActor (ShannonGeminiSpeechStream, String) async throws -> Void

    /// A sentence refused with 429 (the server's per-owner speech slots are busy, for example while
    /// another of her bodies speaks, or a slot of a cancelled sentence is not released yet) is asked
    /// again after these pauses instead of failing the reply's audio.
    static let busyRetryDelays: [Duration] = [.milliseconds(250), .milliseconds(500), .seconds(1), .seconds(2)]

    private let style: @MainActor (String, ShannonVoicePlanDTO?) -> String
    private let streamSpeech: StreamSpeech
    private let consumeSpeech: ConsumeSpeech
    private let busyRetryDelays: [Duration]
    private var tail: Task<Void, Error>?
    private var speechTasks: [UUID: Task<ShannonGeminiSpeechStream, Error>] = [:]
    private var playbackTasks: [UUID: Task<Void, Error>] = [:]
    private var activeCount = 0
    private var isCancelled = false
    private var slotWaiters: [CheckedContinuation<Void, Never>] = []

    init(
        style: @escaping @MainActor (String, ShannonVoicePlanDTO?) -> String,
        streamSpeech: @escaping StreamSpeech,
        consumeSpeech: @escaping ConsumeSpeech,
        busyRetryDelays: [Duration] = ShannonGeminiStreamingSpeechCoordinator.busyRetryDelays
    ) {
        self.style = style
        self.streamSpeech = streamSpeech
        self.consumeSpeech = consumeSpeech
        self.busyRetryDelays = busyRetryDelays
    }

    func enqueue(_ text: String, plan: ShannonVoicePlanDTO?) async {
        let spokenText = ShannonGeminiCascadeSpeech.spokenText(for: text)
        guard !spokenText.isEmpty else { return }
        while activeCount >= 2, !isCancelled {
            guard !Task.isCancelled else { return }
            await withCheckedContinuation { slotWaiters.append($0) }
        }
        guard !isCancelled, !Task.isCancelled else { return }

        activeCount += 1
        let identifier = UUID()
        let speechTask = Task { @MainActor [streamSpeech, style, busyRetryDelays] in
            // At most two sentences are in flight here (the one still streaming and one prefetched),
            // which is the server's limit; a 429 means someone else holds a slot for a moment.
            for delay in busyRetryDelays {
                do { return try await streamSpeech(spokenText, style(text, plan)) } catch ShannonAPIError.rejected(status: 429) {
                    try await Task.sleep(for: delay)
                }
            }
            return try await streamSpeech(spokenText, style(text, plan))
        }
        speechTasks[identifier] = speechTask
        let previous = tail
        let playbackTask = Task { @MainActor [weak self, consumeSpeech] in
            defer { self?.complete(identifier) }
            if let previous { try await previous.value }
            let speech = try await speechTask.value
            try await consumeSpeech(speech, text)
        }
        playbackTasks[identifier] = playbackTask
        tail = playbackTask
    }

    func finish() async throws {
        try await tail?.value
    }

    func cancel() {
        guard !isCancelled else { return }
        isCancelled = true
        for task in speechTasks.values { task.cancel() }
        for task in playbackTasks.values { task.cancel() }
        let waiters = slotWaiters
        slotWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    private func complete(_ identifier: UUID) {
        speechTasks.removeValue(forKey: identifier)
        playbackTasks.removeValue(forKey: identifier)
        activeCount = max(0, activeCount - 1)
        if !slotWaiters.isEmpty { slotWaiters.removeFirst().resume() }
    }
}
