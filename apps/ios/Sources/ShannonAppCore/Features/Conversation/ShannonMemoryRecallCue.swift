import Foundation

/// Mirrors the server's text memory-turn classifier so Talk can say that
/// Shannon is searching memory while the reply is pending. Both sides are
/// checked against `config/memory-recall-cues.json`.
enum ShannonMemoryRecallCue {
    private static let expression = try! NSRegularExpression(
        pattern: "(?:覚えて|おぼえて|忘れて|前に|以前|この前|前回|あの時|あのとき|約束|好み|私の|僕の|ボクの|過去の会話|思い出|目標|目的|続き|踏まえて|今まで|何だっけ|なんだっけ|だったっけ|どうしたっけ|いつだった|どう決めた|なぜ決めた|何を決めた|理由は|経緯|について何を|知ってる[?？]?$|っけ[?？。]?$)",
        options: [.caseInsensitive]
    )

    static func matches(_ text: String) -> Bool {
        let normalized = text.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.count >= 2 else { return false }
        let range = NSRange(normalized.startIndex..., in: normalized)
        return expression.firstMatch(in: normalized, range: range) != nil
    }
}
