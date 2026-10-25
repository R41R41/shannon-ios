import XCTest
@testable import ShannonAppCore

/// The same cases as the Windows app's `tests/fixtures/eleven-style-cases.json` (made by its `tools/eleven-style-cases.ts --swift`):
/// her voice acts a feeling the same way on the iPhone, the Mac and Windows.
final class ShannonElevenStyleCasesTests: XCTestCase {
    private static let cases: [(String, ShannonVoiceAffectDTO?, Double, ShannonVoiceDeliveryDTO, String)] = [
        ("今日はどうしたの？", nil, 0.5, .conversational, "[anime character]"),
        ("ありがとう！", nil, 0.5, .conversational, "[anime character] [cheerfully] [energetically]"),
        ("ふふ、任せて！", nil, 0.5, .conversational, "[anime character] [playfully] [energetically]"),
        ("内緒だよ", nil, 0.5, .conversational, "[anime character] [whispers]"),
        ("ここだけの話なんだけどね", .playful, 0.25, .conversational, "[anime character] [whispers]"),
        ("うん", .neutral, 0.25, .conversational, "[anime character]"),
        ("うん、すぐやるね", .neutral, 0.25, .quick, "[anime character] [playfully] [briskly]"),
        ("了解、確認するね", .neutral, 0.25, .focused, "[anime character] [playfully] [clearly]"),
        ("いいよ", .neutral, 0.6, .energetic, "[anime character] [playfully] [energetically]"),
        ("おはよ", .bright, 0.25, .conversational, "[anime character] [cheerfully] [energetically]"),
        ("やった", .happy, 0.25, .conversational, "[anime character] [cheerfully] [energetically]"),
        ("やった", .happy, 0.6, .conversational, "[anime character] [cheerfully] [energetically]"),
        ("やったー！", .happy, 0.9, .conversational, "[anime character] [excited] [energetically]"),
        ("ほっとした", .content, 0.25, .conversational, "[anime character] [cheerfully] [energetically]"),
        ("ありがとね", .gratitude, 0.6, .conversational, "[anime character] [cheerfully] [energetically]"),
        ("でしょ？", .pride, 0.25, .conversational, "[anime character] [cheerfully] [energetically]"),
        ("すごい！", .excited, 0.25, .conversational, "[anime character] [excited]"),
        ("最高！", .ecstatic, 0.9, .conversational, "[anime character] [excited] [energetically]"),
        ("すごい！", .excited, 0.25, .gentle, "[anime character] [excited]"),
        ("ふふ、どうかな", .playful, 0.25, .conversational, "[anime character] [playfully] [energetically]"),
        ("ふふん", .playful, 0.9, .conversational, "[anime character] [playfully] [energetically]"),
        ("へえ、そうなんだ", .teasing, 0.25, .conversational, "[anime character] [mischievously]"),
        ("やっぱりボクが正しかった", .smug, 0.25, .quick, "[anime character] [smugly] [energetically]"),
        ("はいはい", .deadpan, 0.25, .conversational, "[anime character] [deadpan]"),
        ("そ、そう？", .shy, 0.25, .conversational, "[anime character] [shyly]"),
        ("べ、べつに", .bashful, 0.25, .conversational, "[anime character] [bashfully]"),
        ("な、なに言ってんの", .flustered, 0.25, .conversational, "[anime character] [flustered]"),
        ("べつに", .sulky, 0.25, .conversational, "[anime character] [pouting]"),
        ("ふーん、楽しそうだね", .jealous, 0.25, .conversational, "[anime character] [pouting]"),
        ("もう！", .cuteAngry, 0.25, .conversational, "[anime character] [firmly]"),
        ("ちょっと寂しかった", .lonely, 0.25, .conversational, "[anime character] [wistfully]"),
        ("もうちょっとかまってよ", .attentionSeeking, 0.25, .conversational, "[anime character] [sweetly]"),
        ("ずっと一緒にいるよ", .affectionate, 0.25, .conversational, "[anime character] [lovingly] [softly]"),
        ("そばにいるよ", .tender, 0.25, .gentle, "[anime character] [lovingly] [softly]"),
        ("任せて、進めるね", .tender, 0.25, .gentle, "[anime character] [cheerfully] [energetically]"),
        ("大丈夫？", .caring, 0.25, .gentle, "[anime character] [gently] [calmly]"),
        ("大丈夫だよ", .reassurance, 0.25, .focused, "[anime character] [calmly] [clearly]"),
        ("無理しないで", .protective, 0.25, .focused, "[anime character] [seriously] [clearly]"),
        ("そっか……", .sad, 0.25, .gentle, "[anime character] [sad] [calmly]"),
        ("そっか……", .sad, 0.9, .gentle, "[anime character] [tearfully] [calmly]"),
        ("ごめん", .sad, 0.25, .energetic, "[anime character] [sad]"),
        ("ひどいよ", .hurt, 0.6, .gentle, "[anime character] [sad] [calmly]"),
        ("そっか、だめだったんだ", .disappointed, 0.25, .conversational, "[anime character] [disappointed]"),
        ("ごめんね", .apologetic, 0.25, .gentle, "[anime character] [somberly] [calmly]"),
        ("あの時言えばよかった", .regret, 0.25, .conversational, "[anime character] [somberly]"),
        ("大丈夫かな", .anxious, 0.25, .conversational, "[anime character] [somberly]"),
        ("わっ、待って待って！", .panic, 0.25, .conversational, "[anime character] [panicked]"),
        ("もう！", .annoyed, 0.25, .conversational, "[anime character] [annoyed]"),
        ("もう！", .annoyed, 0.9, .conversational, "[anime character] [angry]"),
        ("うまくいかない", .frustrated, 0.25, .conversational, "[anime character] [frustrated]"),
        ("それはずるいよ", .indignant, 0.6, .conversational, "[anime character] [indignantly]"),
        ("負けないからね", .competitive, 0.25, .conversational, "[anime character] [determined] [energetically]"),
        ("許さない", .seriousAnger, 0.9, .focused, "[anime character] [coldly] [clearly]"),
        ("それはやめて", .protectiveAnger, 0.25, .focused, "[anime character] [seriously] [clearly]"),
        ("それはやめて", .protectiveAnger, 0.6, .focused, "[anime character] [angry] [clearly]"),
        ("えっ", .surprised, 0.25, .conversational, "[anime character] [surprised]"),
        ("えっ、本当に？", .surprised, 0.9, .conversational, "[anime character] [shocked]"),
        ("うそ……", .shocked, 0.25, .conversational, "[anime character] [shocked]"),
        ("えっと、どういうこと？", .confused, 0.25, .conversational, "[anime character] [confused]"),
        ("それってどうなってるの？", .curiosity, 0.25, .conversational, "[anime character] [curiously]"),
        ("了解", .focused, 0.25, .focused, "[anime character] [seriously] [clearly]"),
        ("やってみる", .determined, 0.25, .conversational, "[anime character] [determined]"),
        ("急いで！", .urgent, 0.6, .quick, "[anime character] [urgently] [briskly]"),
        ("ふぁ…もう寝ようかな", .sleepy, 0.25, .gentle, "[anime character] [sleepy] [softly]"),
        ("疲れたね", .tired, 0.25, .gentle, "[anime character] [tired] [calmly]"),
        ("のんびりしよ", .relaxed, 0.25, .conversational, "[anime character] [calmly]"),
    ]

    func testTheSameActingAsTheWindowsApp() {
        XCTAssertGreaterThanOrEqual(Self.cases.count, 40)
        for (text, affect, intensity, delivery, style) in Self.cases {
            let plan = affect.map {
                ShannonVoicePlanDTO(
                    shouldRespond: true, conversationClass: .direct,
                    affect: $0, affectIntensity: intensity, delivery: delivery
                )
            }
            XCTAssertEqual(
                ShannonElevenCascadeSpeech.style(for: text, plan: plan), style,
                "\(text) \(affect.map(\.rawValue) ?? "nil")/\(delivery.rawValue)/\(intensity)"
            )
        }
    }

    func testTheStrengthSteps() {
        XCTAssertEqual(ShannonElevenCascadeSpeech.actingStep(0.25), 0)
        XCTAssertEqual(ShannonElevenCascadeSpeech.actingStep(0.6), 1)
        XCTAssertEqual(ShannonElevenCascadeSpeech.actingStep(0.9), 2)
    }
}
