import CoreGraphics
import Foundation
import Testing
@testable import ShannonAppCore

/// Owner decision 2026-10-05: the chat icon shows the reply's emotion kind when that kind has an icon,
/// and the face icon otherwise. The server sends the kind as `messageEmotion.kind`.
struct ShannonEmotionKindIconTests {
    @Test
    func theListHasTheTwentySixKindsWithTheirSharedNames() {
        #expect(ShannonEmotionKindIcon.allCases.map(\.rawValue) == [
            "pride", "triumphant", "competitive", "mischievous", "plotting", "teasing", "playful", "affectionate",
            "attentionSeeking", "lightPossessive", "gratitude", "sulky", "cuteAngry", "seriousAnger", "frustrated", "lonely",
            "leftOut", "disappointed", "hurt", "lamenting", "anxious", "panic", "speechless", "helpless", "deadpan", "giggle",
        ])
        let names = ShannonEmotionKindIcon.allCases.map(\.japaneseName)
        #expect(Set(names).count == 26)
        #expect(ShannonEmotionKindIcon.pride.japaneseName == "得意げ")
        #expect(ShannonEmotionKindIcon.attentionSeeking.japaneseName == "かまって")
        #expect(ShannonEmotionKindIcon.lightPossessive.japaneseName == "ちょっと独占したい")
        #expect(ShannonEmotionKindIcon.giggle.japaneseName == "くすくす")
        #expect(ShannonEmotionKindIcon.cuteAngry.assetName == "shannon-emotion-cuteAngry")
    }

    @Test
    func anIconIsShownOnlyForAKnownKindWhosePictureIsBundled() {
        #expect(ShannonEmotionKindIcon.displayed(nil, bundled: [.pride]) == nil)
        #expect(ShannonEmotionKindIcon.displayed("aNewerKind", bundled: [.pride]) == nil)
        #expect(ShannonEmotionKindIcon.displayed("smug", bundled: Set(ShannonEmotionKindIcon.allCases)) == nil)
        #expect(ShannonEmotionKindIcon.displayed("pride", bundled: []) == nil)
        #expect(ShannonEmotionKindIcon.displayed("pride", bundled: [.pride]) == .pride)
        // In this build: an icon exactly for the kinds whose file is in the bundle, so a missing file falls back.
        for kind in ShannonEmotionKindIcon.allCases {
            let bundled = ShannonExpressionAssets.url(forAsset: kind.assetName) != nil
            #expect((ShannonEmotionKindIcon.displayed(kind.rawValue) != nil) == bundled, "\(kind.rawValue)")
        }
    }

    @Test
    func aKindIconReplacesTheFaceIconAndItsName() {
        let proud = ShannonFace(expression: .determined, feeling: .proud)
        #expect(ShannonExpressionAssets.assetName(for: proud) == "shannon-expression-determined")
        let triumphant = ShannonFace(expression: .determined, feeling: .proud, kind: .triumphant)
        #expect(ShannonExpressionAssets.assetName(for: triumphant) == "shannon-emotion-triumphant")
        #expect(triumphant.japaneseName == "勝ちほこる")
        #expect(triumphant.accessibilityDescription == "シャノン、勝ちほこる")
        // A kind without a bundled icon keeps the face and its name.
        let fallback = ShannonFace(expression: .determined, feelingName: "proud", kindName: "triumphant")
        if !ShannonEmotionKindIcon.bundled.contains(.triumphant) {
            #expect(fallback == proud)
            #expect(fallback.japaneseName == "得意げ")
        }
    }

    @Test
    func messageEmotionDecodesKindAsAnOptionalNameAndToleratesAnythingElse() throws {
        let withKind = try decode(ShannonMessageEmotionDTO.self,
            #"{"valence":0.3,"arousal":0.5,"openness":0.4,"expression":"determined","feeling":"proud","kind":"triumphant"}"#)
        #expect(withKind.kind == "triumphant")
        #expect(withKind.face.expression == .determined)
        let unknown = try decode(ShannonMessageEmotionDTO.self,
            #"{"valence":0,"arousal":0.3,"openness":0.35,"expression":"calm","kind":"aKindFromLater"}"#)
        #expect(unknown.kind == "aKindFromLater")
        #expect(unknown.face == ShannonFace(expression: .calm))
        let notText = try decode(ShannonMessageEmotionDTO.self,
            #"{"valence":0,"arousal":0.3,"openness":0.35,"expression":"calm","feeling":7,"kind":{"x":1}}"#)
        #expect(notText.kind == nil)
        #expect(notText.feeling == nil)
        let older = try decode(ShannonMessageEmotionDTO.self, #"{"valence":0,"arousal":0.3,"openness":0.35,"expression":"calm"}"#)
        #expect(older.kind == nil)
        #expect(older == ShannonMessageEmotionDTO(valence: 0, arousal: 0.3, openness: 0.35, expression: .calm))
        let reply = try decode(ChatResponseDTO.self, """
        {"mode":"openai","reply":"ふふん。","threadId":"t","snapshotVersion":1,"systemPrompt":"",
         "messageEmotion":{"valence":0.3,"arousal":0.5,"openness":0.4,"expression":"determined","feeling":"proud","kind":"aKindFromLater"},
         "state":{"scopeKey":"owner","version":1,"updatedAt":"2026-10-05T00:00:00Z",
                  "temperament":{"curiosity":0.5,"initiative":0.25,"closeness":0.2,"calmness":0.6,"needForContinuity":0.7,"confidenceAboutUser":0.1},
                  "emotion":{"valence":0,"arousal":0.3,"openness":0.35},"interests":[],"userFacts":[],"activeMemories":[]}}
        """)
        #expect(reply.messageEmotion.face == ShannonFace(expression: .determined, feeling: .proud))
    }

    @Test
    func theKindIsKeptWithTheMessageAndInTheCache() throws {
        let emotion = ShannonMessageEmotionDTO(valence: 0.3, arousal: 0.5, openness: 0.4, expression: .determined, feeling: "proud", kind: "triumphant")
        let snapshot = ConversationMessage.EmotionSnapshot(emotion, stateVersion: 3)
        #expect(snapshot.kind == "triumphant")
        #expect(snapshot.face.kind == ShannonEmotionKindIcon.displayed("triumphant"))
        let restored = try JSONDecoder().decode(
            ShannonConversationCache.CachedEmotion.self,
            from: JSONEncoder().encode(ShannonConversationCache.CachedEmotion(snapshot))
        )
        #expect(restored.value == snapshot)
        let beforeKinds = try decode(ShannonConversationCache.CachedEmotion.self,
            #"{"valence":0,"arousal":0.3,"openness":0.35,"expression":"tender","feeling":null,"stateVersion":2}"#)
        #expect(beforeKinds.value.kind == nil)
    }

    @Test
    func theVoicePlanCarriesTheKindBesideItsFace() throws {
        let plan = try decode(ShannonVoicePlanDTO.self, """
        {"shouldRespond":true,"conversationClass":"direct","affect":"triumphant","delivery":"energetic","selectedSkills":[],
         "expression":"determined","feeling":"proud","kind":"triumphant"}
        """)
        #expect(plan.kind == "triumphant")
        #expect(plan.face?.expression == .determined)
        #expect(plan.face?.kind == ShannonEmotionKindIcon.displayed("triumphant"))
    }

    // MARK: The canvas of the icons

    @Test
    func onlyTheCanvasJoinedToTheEdgeTurnsWhite() throws {
        // A lavender canvas, a dark ring, and inside it pale lavender and pale pink "hair" as pale as the canvas.
        let side = 96
        let canvas: (UInt8, UInt8, UInt8) = (228, 213, 253)
        let source = try #require(image(side: side) { x, y in
            let dx = x - side / 2, dy = y - side / 2
            let radius = dx * dx + dy * dy
            if radius < 12 * 12 { return canvas }               // enclosed by the ring: stays
            if radius < 20 * 20 { return (240, 220, 250) }      // pale pink highlight: stays
            if radius < 26 * 26 { return (20, 30, 120) }        // outline
            return canvas
        })
        let rendered = try #require(ShannonPortraitBackground.whitened(source))
        let output = pixels(rendered)
        let scale = ShannonPortraitBackground.outputSide / side
        let at = { (x: Int, y: Int) in output[(y * scale) * ShannonPortraitBackground.outputSide + x * scale] }
        #expect(at(2, 2) == [255, 255, 255])
        #expect(at(side - 3, side / 2) == [255, 255, 255])
        #expect(at(side / 2, side / 2) == [228, 213, 253])
        #expect(at(side / 2 + 16, side / 2) == [240, 220, 250])
    }

    @Test
    func aPictureWithoutAPaleCanvasIsLeftAsItIs() throws {
        let source = try #require(image(side: 16) { _, _ in (40, 60, 90) })
        let output = pixels(try #require(ShannonPortraitBackground.whitened(source)))
        #expect(output.allSatisfy { $0 == [40, 60, 90] })
    }

    @Test
    func theBundledFacesGetAWhiteCanvasAndKeepTheirFigure() throws {
        for expression in ShannonExpressionDTO.allCases {
            try expectWhiteCanvasAndFigure(asset: expression.assetName)
        }
    }

    @Test
    func theBundledKindPicturesGetAWhiteCanvasAndKeepTheirFigure() throws {
        // All 26 are in this build; each is drawn and whitened like the faces.
        #expect(ShannonEmotionKindIcon.bundled == Set(ShannonEmotionKindIcon.allCases))
        for kind in ShannonEmotionKindIcon.allCases {
            try expectWhiteCanvasAndFigure(asset: kind.assetName)
        }
    }

    @Test
    func aFaceMadeWithAKindWhosePictureIsNotBundledShowsTheFace() {
        let proud = ShannonFace(expression: .determined, feeling: .proud)
        let unbundled = ShannonFace(expression: .determined, feeling: .proud, kind: .triumphant, bundled: [.pride])
        #expect(unbundled == proud)
        #expect(unbundled.kind == nil)
        #expect(ShannonExpressionAssets.assetName(for: unbundled) == "shannon-expression-determined")
        #expect(unbundled.japaneseName == "得意げ")
        let bundled = ShannonFace(expression: .determined, feeling: .proud, kind: .pride, bundled: [.pride])
        #expect(bundled.kind == .pride)
    }

    /// A bundled icon is 384×384 (the loader's own size, so nothing larger is shipped), its top corner becomes
    /// white, and the white canvas stays between a tenth and a half of the picture.
    private func expectWhiteCanvasAndFigure(asset name: String) throws {
        let url = try #require(ShannonExpressionAssets.url(forAsset: name), "\(name)")
        let data = try Data(contentsOf: url)
        let provider = try #require(CGDataProvider(data: data as CFData))
        let source = try #require(CGImage(pngDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent))
        #expect(source.width == ShannonPortraitBackground.outputSide && source.height == ShannonPortraitBackground.outputSide, "\(name)")
        let output = pixels(try #require(ShannonPortraitBackground.whitened(source)))
        #expect(output[0] == [255, 255, 255], "\(name)")
        let white = output.filter { $0 == [255, 255, 255] }.count
        // The canvas is about a quarter of each picture; the figure is never whitened away.
        #expect(white > output.count / 10 && white < output.count / 2, "\(name): \(white)")
    }

    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func image(side: Int, colour: (Int, Int) -> (UInt8, UInt8, UInt8)) -> CGImage? {
        var bytes = [UInt8](repeating: 255, count: side * side * 4)
        for y in 0..<side {
            for x in 0..<side {
                let (red, green, blue) = colour(x, y)
                let index = (y * side + x) * 4
                bytes[index] = red
                bytes[index + 1] = green
                bytes[index + 2] = blue
            }
        }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4, space: space,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                       decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    private func pixels(_ image: CGImage) -> [[UInt8]] {
        let side = image.width
        var bytes = [UInt8](repeating: 0, count: side * image.height * 4)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: &bytes, width: side, height: image.height, bitsPerComponent: 8, bytesPerRow: side * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: image.height))
        return stride(from: 0, to: bytes.count, by: 4).map { [bytes[$0], bytes[$0 + 1], bytes[$0 + 2]] }
    }
}
