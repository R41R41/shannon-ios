import Testing
@testable import ShannonAppCore

@Suite struct ShannonVoiceLocationIntentTests {
    @Test(arguments: [
        "ここから浜松城までバスで行きたい",
        "今いる場所の近くで雨でも楽しめる所は？",
        "現在地を教えて",
        "最寄り駅は？",
    ])
    func requestsOneTimeLocationForLocalQuestions(_ utterance: String) {
        #expect(ShannonVoiceLocationIntent.needsCurrentLocation(utterance))
    }

    @Test(arguments: [
        "今何時？",
        "浜松の歴史を教えて",
        "東京の天気は？",
    ])
    func doesNotRequestLocationForUnrelatedQuestions(_ utterance: String) {
        #expect(!ShannonVoiceLocationIntent.needsCurrentLocation(utterance))
    }
}
