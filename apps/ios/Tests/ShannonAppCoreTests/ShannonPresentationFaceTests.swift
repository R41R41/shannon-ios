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

    @Test
    func withoutAnIdTheUsualFaceAndAnUnknownIdTheNeutralOne() {
        #expect(ShannonPresentationFace.drawnID(for: nil) == nil)
        #expect(ShannonPresentationFace.drawnID(for: "fromANewerServer") == "neutral")
        #expect(ShannonPresentationFace.assetName(for: "fromANewerServer") == "shannon-face-neutral")
        #expect(ShannonPresentationFace.japaneseName(for: "fromANewerServer") == "ふだんどおり")
        #expect(ShannonPresentationFace.eyeExpression(for: "fromANewerServer") == .neutral)
    }

    @Test
    func noPublicIdIsDrawnWithAnOwnerOnlyFace() {
        #expect(ShannonPresentationFace.ownerOnly == ["jealous", "tender", "tsun"])
        for id in ShannonPresentationFace.bundledIDs.subtracting(ShannonPresentationFace.ownerOnly) {
            #expect(!ShannonPresentationFace.ownerOnly.contains(ShannonPresentationFace.drawnID(for: id) ?? ""), "\(id)")
            // Not even as the eyes' nearest face (the server's nearest for 「そっぽ」 is `jealous`).
            #expect(![.jealous, .tender].contains(ShannonPresentationFace.eyeExpression(for: id)), "\(id)")
        }
        #expect(ShannonPresentationFace.eyeExpression(for: "turnAway") == .annoyed)
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
