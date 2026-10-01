import Testing
@testable import ShannonAppCore

struct ShannonPlaceLinksTests {
    @Test func voiceReplyKeepsLinksInHistoryWithoutChangingSpokenReply() {
        let place = ShannonPlaceDTO(name: "浜松城公園", address: "静岡県浜松市", reason: "散歩できる",
                                    mapQuery: "浜松城公園 静岡県浜松市",
                                    mapUrl: "https://maps.apple.com/?q=hamamatsu")
        let history = ShannonPlaceLinks.appending([place], to: "公園を見つけたよ。")
        #expect(history.contains("地図で開く"))
        #expect(ShannonPlaceLinks.places(in: history).first?.name == "浜松城公園")
        #expect(ShannonPlaceLinks.places(in: history).first?.mapQuery == "hamamatsu")
        #expect(ShannonPlaceLinks.places(in: "- [偽の地図](https://example.com/) — 住所").isEmpty)
    }
}
