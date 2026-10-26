import Foundation
import Testing
@testable import ShannonAppCore

/// The face beside each reply (Syzygy ADR-0013 D17, owner choice A): the reply's stored presentation id, its picture,
/// and the fallbacks.
struct ShannonPresentationFaceTests {
    /// The server's presentation vocabulary, version 1 (`packages/cognition/src/presentation.ts`, `PRESENTATION_IDS`).
    static let vocabularyOne = [
        "joyful", "excited", "amused", "laughing", "bashful", "embarrassed", "relieved", "surprised", "curious", "thinking", "confused",
        "determined", "tender", "calm", "jealous", "wry", "exasperated", "annoyed", "concerned", "sad", "sleepy", "neutral", "proud",
        "flustered", "apologetic", "businessSmile", "strainedSmile", "blankFace", "listless", "tongueClick", "coverUp", "irked",
        "banVerdict", "flatStare", "turnAway", "tsun", "holdingBackTears",
    ]

    @Test
    func everyIdOfTheVocabularyDrawsItsOwnBundledPicture() {
        for id in Self.vocabularyOne {
            #expect(ShannonPresentationFace.drawnID(for: id) == id)
            #expect(ShannonPresentationFace.assetName(for: id) == "shannon-face-\(id)")
        }
        // The 33 faces of the model and the twelve new ones, each in the bundle under its id.
        #expect(ShannonPresentationFace.bundledIDs.count == 45)
        for id in ShannonPresentationFace.bundledIDs {
            #expect(Bundle.module.url(forResource: "shannon-face-\(id)", withExtension: "png") != nil, "\(id)")
            #expect(!ShannonPresentationFace.japaneseName(for: id).isEmpty)
        }
    }

    /// The ガール icon beside a reply is one of the drawn pictures, never a Live2D render (owner, 2026-10-26: some icons
    /// looked like screenshots of the Live2D figure).
    @Test
    func everyIdIsDrawnWithADrawnPictureNotALive2DRender() {
        for id in ShannonPresentationFace.bundledIDs.union(["fromANewerServer"]) {
            let name = ShannonPresentationFace.pictureAssetName(for: id)
            #expect(name.hasPrefix("shannon-expression-") || name.hasPrefix("shannon-emotion-"), "\(id)")
            #expect(ShannonExpressionAssets.url(forAsset: name) != nil, "\(id) → \(name)")
        }
        #expect(ShannonPresentationFace.pictureAssetName(for: "irked") == "shannon-expression-annoyed")
        #expect(ShannonPresentationFace.pictureAssetName(for: "flatStare") == "shannon-emotion-deadpan")
        #expect(ShannonPresentationFace.pictureAssetName(for: "tender") == "shannon-expression-tender")
        #expect(ShannonPresentationFace.pictureAssetName(for: "blankFace") == "shannon-expression-neutral")
        #expect(ShannonPresentationFace.pictureAssetName(for: "fromANewerServer") == "shannon-expression-neutral")
    }

    @Test
    func withoutAnIdTheUsualFaceAndAnUnknownIdTheNeutralOne() {
        #expect(ShannonPresentationFace.drawnID(for: nil) == nil)
        #expect(ShannonPresentationFace.drawnID(for: "fromANewerServer") == "neutral")
        #expect(ShannonPresentationFace.assetName(for: "fromANewerServer") == "shannon-face-neutral")
        #expect(ShannonPresentationFace.japaneseName(for: "fromANewerServer") == "ふだんどおり")
        #expect(ShannonPresentationFace.eyeExpression(for: "fromANewerServer") == .neutral)
    }

    @Test
    func everyIdIsDrawnWithItsOwnFaceInPublicToo() {
        // Owner, 2026-10-14 (「嫉妬も甘えも出す」): no client-side rule narrows a face; each id draws its own.
        for id in ["jealous", "tender", "tsun", "turnAway", "flatStare"] {
            #expect(ShannonPresentationFace.drawnID(for: id) == id)
        }
        // The eyes take the server's nearest face (`expression` beside the single face's `feeling`).
        #expect(ShannonPresentationFace.eyeExpression(for: "turnAway") == .jealous)
        #expect(ShannonPresentationFace.eyeExpression(for: "tsun") == .jealous)
        #expect(ShannonPresentationFace.eyeExpression(for: "tender") == .tender)
        #expect(ShannonPresentationFace.japaneseName(for: "flatStare") == "ジト目")
    }

    @Test
    func theIdIsReadAndKeptWithTheReply() throws {
        let json = #"{"valence":0.1,"arousal":0.5,"openness":0.4,"expression":"exasperated","presentationId":"flatStare"}"#
        let emotion = try JSONDecoder().decode(ShannonMessageEmotionDTO.self, from: Data(json.utf8))
        #expect(emotion.presentationId == "flatStare")
        let snapshot = ConversationMessage.EmotionSnapshot(emotion, stateVersion: 3)
        #expect(snapshot.presentationId == "flatStare")
        // An older server says none; a value that is not text is read as none, never as a failed reply.
        let older = try JSONDecoder().decode(ShannonMessageEmotionDTO.self,
                                             from: Data(#"{"valence":0,"arousal":0,"openness":0,"expression":"calm"}"#.utf8))
        #expect(older.presentationId == nil)
        let odd = try JSONDecoder().decode(ShannonMessageEmotionDTO.self,
                                           from: Data(#"{"valence":0,"arousal":0,"openness":0,"expression":"calm","presentationId":7}"#.utf8))
        #expect(odd.presentationId == nil)

        // The display cache keeps it, so the history shows the face of that time; an older cache has none.
        let cached = ShannonConversationCache.CachedEmotion(snapshot)
        let restored = try JSONDecoder().decode(ShannonConversationCache.CachedEmotion.self, from: JSONEncoder().encode(cached)).value
        #expect(restored.presentationId == "flatStare")
        let oldCache = #"{"valence":0,"arousal":0,"openness":0,"expression":"calm","stateVersion":1}"#
        #expect(try JSONDecoder().decode(ShannonConversationCache.CachedEmotion.self, from: Data(oldCache.utf8)).value.presentationId == nil)
    }

    @Test @MainActor
    func theAvatarDrawsTheIdAndWithoutOneTheFaceOfTheFeeling() {
        let shown = ConversationMessage.EmotionSnapshot(valence: 0, arousal: 0, openness: 0, expression: .jealous,
                                                        presentationId: "turnAway", stateVersion: 1)
        #expect(ShannonMessageAvatarView(emotion: shown).presentationID == "turnAway")
        let older = ConversationMessage.EmotionSnapshot(valence: 0, arousal: 0, openness: 0, expression: .bashful, stateVersion: 1)
        let fallback = ShannonMessageAvatarView(emotion: older)
        #expect(fallback.presentationID == nil)
        #expect(fallback.face == ShannonFace(expression: .bashful))
        #expect(ShannonMessageAvatarView(emotion: nil).presentationID == nil)
        #expect(ShannonMessageRow.avatarSize == 36)
    }
}
