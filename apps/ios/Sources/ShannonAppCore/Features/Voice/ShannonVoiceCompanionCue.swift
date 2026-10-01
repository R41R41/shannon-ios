import Foundation

/// A small, deterministic rule set for the owner saying that someone else has joined.
///
/// It only ever moves a call from 本人だけ to 友人も一緒, the more private direction. Nothing
/// spoken can move it back: a friend's voice must not be able to unlock the owner's context.
enum ShannonVoiceCompanionCue: Equatable, Sendable {
    /// The owner plainly said a friend is here or is being introduced.
    case switchToGuest
    /// Someone may be present, but the wording is not certain enough to switch silently.
    case ask

    /// Shannon's fixed question for `.ask`. It is spoken without sending the utterance to the model.
    static let question = "お友達も一緒ですか？ 「うん」と言ってもらえれば、「友人も一緒」に切り替えますね。"

    private static let person = "(?:お友達|お友だち|友達|友だち|ともだち|友人|彼女|彼氏|恋人|同僚|先輩|後輩|家族|奥さん|旦那|妻|夫|お母さん|お父さん|母|父|兄|姉|弟|妹|知り合い|知人)"

    /// Past, future, hypothetical, negated, reported, or third-party introductions are not "here now".
    private static let exclusions = [
        "しない", "じゃない", "ではない", "いない", "いません", "やめ", "なくて", "なかった",
        "昨日", "先週", "先月", "この前", "こないだ", "さっき", "前に", "今度", "明日", "来週", "いつか", "そのうち",
        "もし", "たら", "なら", "場合", "としたら",
        "って言って", "らしい",
        "紹介して(?:ほしい|欲しい|くれ|もらっ|もらい|もらう|あげ)", "紹介され", "紹介する方法", "紹介の仕方",
        "(?:した|してた|していた|いた|来てた|だった|ました|でした)$",
    ]

    private static let certain = [
        "友人も一緒(?:に(?:して|切り替え|する|なる)|で(?:お願い|話)|モード)",
        "\(person)(?:を|に)?(?:君|きみ|シャノン)?(?:を|に)?紹介(?:する(?:ね|よ|わ)?|します(?:ね)?|させて)$",
        "\(person)(?:と|も)一緒(?:にいる(?:よ|んだ|の)?|にいます|だよ|です|なんだ|なの)?$",
        "(?:今|いま).*\(person)と.*紹介(?:したい|する(?:ね|よ)?|します)$",
        "\(person)と(?:ご飯|ごはん|食事|お茶|カフェ|飲み).*て.*紹介(?:したい|する(?:ね|よ)?|します)$",
    ]

    private static let uncertain = [
        "\(person)(?:が|も)(?:いる|います|来てる|来ています|来た|隣|そば|横|近く|一緒(?:$|にい|に来て|だ|です))",
        "\(person)と(?:いる|います|ご飯|ごはん|食事|お茶|カフェ|飲んで|食べて)",
        "\(person)に(?:も)?(?:自己紹介|挨拶|あいさつ)して",
        "\(person).*紹介(?:したい|してもいい|していい)",
        "紹介(?:したい|してもいい|していい).*\(person)",
    ]

    static func detect(in text: String) -> ShannonVoiceCompanionCue? {
        let value = compact(text)
        guard value.count <= 60, matches(value, any: [person]) || value.contains("友人も一緒") else { return nil }
        guard !matches(value, any: exclusions) else { return nil }
        if matches(value, any: certain) { return .switchToGuest }
        // A question about introductions in general is not a statement that someone is here.
        if value.hasSuffix("か") || value.hasSuffix("かな"), !value.contains("紹介して") { return nil }
        return matches(value, any: uncertain) ? .ask : nil
    }

    /// A short, plain yes to `question`. Anything longer or negated leaves the call as it is.
    static func confirms(_ text: String) -> Bool {
        let value = compact(text)
        guard !value.isEmpty, value.count <= 14 else { return false }
        guard !matches(value, any: ["ない", "いや", "違", "ちが", "やめ", "一人", "ひとり", "だけ"]) else { return false }
        return matches(value, any: [
            "^(?:うん|はい|ええ|そう|そうそう|そうだよ|そうです|そうなんだ|一緒|いるよ|います|お願い|切り替えて|オッケー|ok)",
            "紹介(?:したい|する|します)",
        ])
    }

    private static func compact(_ text: String) -> String {
        text.precomposedStringWithCompatibilityMapping.lowercased()
            .components(separatedBy: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters).union(.symbols))
            .joined()
    }

    private static func matches(_ value: String, any patterns: [String]) -> Bool {
        patterns.contains { value.range(of: $0, options: .regularExpression) != nil }
    }
}
