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
/// - Each id draws its own picture, whoever was there: the faces are not restricted in public or on a stream (owner,
///   2026-10-14: 「嫉妬も甘えも出す」). Which feeling to show in front of others is the server's choice, never the client's.
///
/// The pictures are `shannon-face-<id>.png` (108 px, 36 pt at 3×), rendered from Live2D by `scripts/render-face-icons.py`;
/// the names are keyed by the id and stay stable when the art is rendered again.
public enum ShannonPresentationFace {
    /// The id drawn when the id is not known here.
    public static let fallbackID = "neutral"

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

    /// The Waterlight eye shape (the ボット avatar) for an id: one of the 22 faces, the server's nearest face for the id.
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

    /// The drawn picture beside a reply in the ガール style: a face's own picture, a feeling kind's picture where that kind is
    /// the face (ジト目 is deadpan, ドヤ顔 triumphant), else the nearest face's picture. The `shannon-face-*` pictures are rendered
    /// from Live2D and looked like screenshots among the drawn ones (owner, 2026-10-26), so they are not the icon any more.
    public static func pictureAssetName(for id: String) -> String {
        let drawn = drawnID(for: id) ?? fallbackID
        if let expression = ShannonExpressionDTO(rawValue: drawn) { return expression.assetName }
        if let kind = kindPicture[drawn], ShannonEmotionKindIcon.bundled.contains(kind) { return kind.assetName }
        return (nearest[drawn] ?? .neutral).assetName
    }

    /// Ids that are one of the drawn feeling kinds; the others take the nearest face (`nearest`).
    private static let kindPicture: [String: ShannonEmotionKindIcon] = [
        "proud": .pride, "smug": .triumphant, "flatStare": .deadpan, "pout": .sulky, "tsun": .sulky, "shocked": .speechless,
        "wink": .playful, "coverUp": .giggle, "tongueClick": .frustrated, "angry": .cuteAngry, "crying": .lamenting,
        "wail": .lamenting,
    ]

    private static let nearest: [String: ShannonExpressionDTO] = [
        "proud": .determined, "flustered": .embarrassed, "apologetic": .concerned,
        "businessSmile": .joyful, "strainedSmile": .wry, "blankFace": .calm, "listless": .sleepy, "tongueClick": .annoyed,
        "coverUp": .amused, "irked": .annoyed, "banVerdict": .annoyed, "flatStare": .exasperated, "turnAway": .jealous,
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
