import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The face a reply was shown with (Syzygy ADR-0013 D17; `messageEmotion.presentationId`, kept per reply in
/// `ConversationMessage.EmotionSnapshot`). The owner chose a small round face beside each reply, without a name
/// (comparison page, option A). This is the one table from an id to its picture.
///
/// - No id (an older server, an older cache): nil, and the message shows its usual face (`ShannonMessageAvatarMood`).
/// - An id this build has no picture for (a newer server): the neutral face, never a guess.
/// - Each id draws its own picture only. With anyone else there the server sends the public layer's id, and no public id
///   is drawn with a face of the owner-only layer (`ownerOnly`), not even as the nearest one.
///
/// The pictures are `shannon-face-<id>.png` (108 px, 36 pt at 3×), rendered from Live2D by `scripts/render-face-icons.py`;
/// the names are keyed by the id and stay stable when the art is rendered again.
public enum ShannonPresentationFace {
    /// The id drawn when the id is not known here.
    public static let fallbackID = "neutral"

    /// The owner-only layer (the server's `OWNER_ONLY_PRESENTATION_IDS`): shown to the owner alone, never in front of others.
    public static let ownerOnly: Set<String> = ["jealous", "tender", "tsun"]

    /// Every id with a picture: the server's presentation vocabulary (version 1) and the other faces of the Live2D model.
    public static let bundledIDs: Set<String> = [
        // The 22 faces.
        "joyful", "excited", "amused", "laughing", "bashful", "embarrassed", "relieved", "surprised", "curious", "thinking", "confused",
        "determined", "tender", "calm", "jealous", "wry", "exasperated", "annoyed", "concerned", "sad", "sleepy", "neutral",
        // The borrowed feelings, now with faces of their own.
        "proud", "flustered", "apologetic",
        // The twelve single faces (desktop body `faces-12`).
        "businessSmile", "strainedSmile", "blankFace", "listless", "tongueClick", "coverUp", "irked", "banVerdict", "flatStare",
        "turnAway", "tsun", "holdingBackTears",
        // The model's other faces (not in vocabulary 1 yet).
        "angry", "crying", "pout", "shocked", "shout", "smug", "wail", "wink",
    ]

    /// The id whose picture is drawn: the id itself when known, the neutral face otherwise; nil without an id.
    public static func drawnID(for id: String?) -> String? {
        guard let id else { return nil }
        return bundledIDs.contains(id) ? id : fallbackID
    }

    /// The picture's resource name for an id (`drawnID` first).
    public static func assetName(for id: String) -> String {
        "shannon-face-\(drawnID(for: id) ?? fallbackID)"
    }

    /// The Waterlight eye shape (the ボット avatar) for an id: one of the 22 faces. A public id never reads as an owner-only one
    /// (the server's nearest face for 「そっぽ」 is `jealous`; here it is `annoyed`).
    public static func eyeExpression(for id: String) -> ShannonExpressionDTO {
        guard let drawn = drawnID(for: id) else { return .neutral }
        if let expression = ShannonExpressionDTO(rawValue: drawn) { return expression }
        return nearest[drawn] ?? .neutral
    }

    /// The name VoiceOver reads (「シャノン、ジト目」); the screen shows no name (option A).
    public static func japaneseName(for id: String) -> String {
        let drawn = drawnID(for: id) ?? fallbackID
        if let feeling = ShannonFeelingDTO(rawValue: drawn) { return feeling.japaneseName }
        if let expression = ShannonExpressionDTO(rawValue: drawn) { return expression.japaneseName }
        return names[drawn] ?? ShannonExpressionDTO.neutral.japaneseName
    }

    private static let nearest: [String: ShannonExpressionDTO] = [
        "proud": .determined, "flustered": .embarrassed, "apologetic": .concerned,
        "businessSmile": .joyful, "strainedSmile": .wry, "blankFace": .calm, "listless": .sleepy, "tongueClick": .annoyed,
        "coverUp": .amused, "irked": .annoyed, "banVerdict": .annoyed, "flatStare": .exasperated, "turnAway": .annoyed,
        "tsun": .jealous, "holdingBackTears": .sad,
        "angry": .annoyed, "crying": .sad, "pout": .annoyed, "shocked": .surprised, "shout": .annoyed, "smug": .determined,
        "wail": .sad, "wink": .amused,
    ]

    private static let names: [String: String] = [
        "businessSmile": "営業スマイル", "strainedSmile": "引きつった笑顔", "blankFace": "素の顔", "listless": "ダルそう",
        "tongueClick": "舌打ち", "coverUp": "ごまかし笑い", "irked": "いらっとしている", "banVerdict": "突きつけている",
        "flatStare": "ジト目", "turnAway": "そっぽを向いている", "tsun": "ツンとしている", "holdingBackTears": "泣きそう",
        "angry": "怒っている", "crying": "泣いている", "pout": "ふくれている", "shocked": "がーん", "shout": "叫んでいる",
        "smug": "ドヤ顔", "wail": "大泣き", "wink": "ウインク",
    ]
}

/// The small round face of option A: the picture of the reply's presentation id, cropped to a circle, nothing else.
struct ShannonPresentationFaceView: View {
    let id: String
    let size: CGFloat

    var body: some View {
        picture
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(Circle())
    }

    private var picture: Image {
        for name in [ShannonPresentationFace.assetName(for: id), "shannon-face-\(ShannonPresentationFace.fallbackID)"] {
#if canImport(UIKit)
            if let image = UIImage(named: name, in: .module, compatibleWith: nil) { return Image(uiImage: image) }
#elseif canImport(AppKit)
            if let image = Bundle.module.image(forResource: name) { return Image(nsImage: image) }
#endif
        }
        return Image(systemName: "person.crop.circle.fill")
    }
}
