import Foundation
import Testing
@testable import ShannonAppCore

struct ShannonFaceTests {
    @Test
    func everyExpressionHasOneNameSharedByBothPlatforms() {
        let names = ShannonExpressionDTO.allCases.map(\.japaneseName)
        #expect(Set(names).count == ShannonExpressionDTO.allCases.count)
        #expect(names.allSatisfy { !$0.isEmpty })
        // The eight names the Mac used to replace with its own wording (PE-30).
        #expect(ShannonExpressionDTO.confused.japaneseName == "困惑している")
        #expect(ShannonExpressionDTO.jealous.japaneseName == "やきもち")
        #expect(ShannonExpressionDTO.determined.japaneseName == "やる気")
        #expect(ShannonExpressionDTO.sad.japaneseName == "かなしい")
        #expect(ShannonExpressionDTO.annoyed.japaneseName == "むっとしている")
        #expect(ShannonExpressionDTO.laughing.japaneseName == "爆笑")
        #expect(ShannonExpressionDTO.tender.japaneseName == "やさしい")
        #expect(ShannonExpressionDTO.neutral.japaneseName == "ふだんどおり")
    }

    @Test
    func voiceOverNeverReadsADoubledNoun() {
        for expression in ShannonExpressionDTO.allCases {
            let spoken = ShannonFace(expression: expression).accessibilityDescription
            #expect(spoken == "シャノン、\(expression.japaneseName)")
            #expect(!spoken.contains("表情表情"))
            #expect(!spoken.hasSuffix("表情"))
        }
    }

    @Test
    func coreFeelingsBorrowAFaceAndKeepTheirOwnName() {
        #expect(ShannonFace(expression: .determined, feeling: .proud).japaneseName == "得意げ")
        #expect(ShannonFace(expression: .embarrassed, feeling: .flustered).japaneseName == "慌てている")
        #expect(ShannonFace(expression: .concerned, feeling: .apologetic).japaneseName == "申し訳なさそう")
        #expect(ShannonFace(expression: .concerned, feeling: .apologetic).accessibilityDescription == "シャノン、申し訳なさそう")
        #expect(ShannonFace(expression: .bashful).japaneseName == "照れ笑い")
        // A feeling this build does not know falls back to the face's own name.
        #expect(ShannonFace(expression: .determined, feelingName: "from-a-newer-server").japaneseName == "やる気")
    }

    @Test
    func messageEmotionDecodesWithAndWithoutAFeeling() throws {
        let proud = try decode(ShannonMessageEmotionDTO.self,
            #"{"valence":0.4,"arousal":0.6,"openness":0.4,"expression":"determined","feeling":"proud"}"#)
        #expect(proud.face == ShannonFace(expression: .determined, feeling: .proud))
        let older = try decode(ShannonMessageEmotionDTO.self,
            #"{"valence":0,"arousal":0.3,"openness":0.35,"expression":"calm"}"#)
        #expect(older.face == ShannonFace(expression: .calm))
        let newer = try decode(ShannonMessageEmotionDTO.self,
            #"{"valence":0,"arousal":0.3,"openness":0.35,"expression":"calm","feeling":"unknown-later"}"#)
        #expect(newer.face.japaneseName == "穏やか")

        let snapshot = ConversationMessage.EmotionSnapshot(proud, stateVersion: 3)
        #expect(snapshot.face.japaneseName == "得意げ")
        let cached = ShannonConversationCache.CachedEmotion(snapshot)
        let restored = try JSONDecoder().decode(
            ShannonConversationCache.CachedEmotion.self, from: JSONEncoder().encode(cached)
        )
        #expect(restored.value == snapshot)
        // A cache written before feelings existed still loads.
        let legacy = try decode(ShannonConversationCache.CachedEmotion.self,
            #"{"valence":0,"arousal":0.3,"openness":0.35,"expression":"tender","stateVersion":2}"#)
        #expect(legacy.value.face == ShannonFace(expression: .tender))
    }

    @Test
    func voicePlanCarriesTheFaceOfTheEmotionTheVoiceActsWith() throws {
        let plan = try decode(ShannonVoicePlanDTO.self, """
        {"shouldRespond":true,"conversationClass":"direct","affect":"smug","affectIntensity":0.7,
         "delivery":"energetic","selectedSkills":[],"expression":"determined","feeling":"proud",
         "emotion":{"primary":"smug"}}
        """)
        #expect(plan.face == ShannonFace(expression: .determined, feeling: .proud))
        #expect(plan.turnEmotion == ShannonVoiceTurnEmotionDTO(primary: "smug", intensity: 0.7))

        let older = try decode(ShannonVoicePlanDTO.self,
            #"{"shouldRespond":true,"conversationClass":"direct","affect":"happy","delivery":"conversational","selectedSkills":[]}"#)
        #expect(older.face == nil)
        let unknown = try decode(ShannonVoicePlanDTO.self,
            #"{"shouldRespond":true,"conversationClass":"direct","affect":"happy","delivery":"conversational","selectedSkills":[],"expression":"later-face"}"#)
        #expect(unknown.face == nil)

        let request = ShannonRealtimeVoiceTurnRequestDTO(
            scopeKey: "owner", threadId: "call", userTranscript: "できた？", shannonTranscript: "ふふん。",
            emotion: plan.turnEmotion
        )
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let emotion = try #require(body["emotion"] as? [String: Any])
        #expect(emotion["primary"] as? String == "smug")
    }

    @Test
    func presentedStateDecodesAndOlderServersStayReadable() throws {
        let state = try decode(CompanionStateDTO.self, """
        {"scopeKey":"owner","version":4,"updatedAt":"2026-10-02T00:00:00Z",
         "temperament":{"curiosity":0.53,"initiative":0.25,"closeness":0.22,"calmness":0.6,
                        "needForContinuity":0.7,"confidenceAboutUser":0.08},
         "emotion":{"valence":0,"arousal":0.3,"openness":0.35},
         "interests":[],"userFacts":[],"activeMemories":[],"sharedDays":["2026-10-02"],
         "presence":{"mood":{"expression":"concerned","feeling":"apologetic","cause":"生成した応答の内容と会話文脈","fromConversation":true},
                     "temperamentReasons":{"closeness":"この30日で4日話した","curiosity":"いま育っている関心1件","confidenceAboutUser":"覚えていること1件から"}}}
        """)
        #expect(state.presence?.mood.face.japaneseName == "申し訳なさそう")
        #expect(state.presence?.temperamentReasons.closeness == "この30日で4日話した")
        let mood = ShannonMemoryOverview.mood(for: state)
        #expect(mood.label == "申し訳なさそう")
        #expect(mood.expression == .concerned)
        #expect(mood.cause == "生成した応答の内容と会話文脈")

        let older = try decode(CompanionStateDTO.self, """
        {"scopeKey":"owner","version":4,"updatedAt":"2026-10-02T00:00:00Z",
         "temperament":{"curiosity":0.65,"initiative":0.25,"closeness":0.15,"calmness":0.6,
                        "needForContinuity":0.7,"confidenceAboutUser":0.05},
         "emotion":{"valence":0,"arousal":0.3,"openness":0.35},
         "interests":[],"userFacts":[],"activeMemories":[]}
        """)
        #expect(older.presence == nil)
        // Without a presented feeling the constant trait is no longer named as her mood.
        #expect(ShannonMemoryOverview.mood(for: older).label == "穏やか")
    }

    @MainActor
    @Test
    func theFaceBeforeAnyReplyIsCalmNotAFixedCuriosity() {
        let model = ShannonConversationModel(messages: [], usesDisplayCache: false)
        #expect(model.currentFace == ShannonFace(expression: .calm))
        #expect(model.currentExpression == .calm)
        #expect(model.presentFace == ShannonFace(expression: .calm))
    }

    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
}
