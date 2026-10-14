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

    /// The presentation id of her latest reply in these messages (the Mac's Dock and menu-bar face, owner choice A of the resident
    /// icons). Nil when she has not replied or her latest reply has none (an older server): the icon stays as it is today.
    public static func latestID(in messages: [ConversationMessage]) -> String? {
        messages.last { $0.role == .shannon }?.emotionSnapshot?.presentationId
    }

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

#if canImport(AppKit)
extension ShannonPresentationFace {
    /// Her face for the menu bar: the picture of the id, cropped to a circle, 18 pt, in colour (not a template).
    /// Nil without an id: the menu bar keeps its symbol.
    public static func menuBarImage(for id: String?, side: CGFloat = 18) -> NSImage? {
        guard let drawn = drawnID(for: id), let picture = Bundle.module.image(forResource: "shannon-face-\(drawn)") else { return nil }
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSBezierPath(ovalIn: rect).addClip()
            picture.draw(in: rect)
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "シャノン、\(japaneseName(for: drawn))"
        return image
    }
}

/// The Dock icon and the menu-bar item of the Mac app follow her latest reply's face (Syzygy ADR-0013 D17, owner choice A
/// 「顔がそのまま変わる」): the same 45 pictures as the talk screen. No id: today's icon. An unknown id: the neutral face.
/// Setting `applicationIconImage` shows no system prompt. The iPhone's home icon never changes.
struct ShannonResidentFaceModifier: ViewModifier {
    let conversation: ShannonConversationModel
    let appIcon: ShannonAppIconModel

    func body(content: Content) -> some View {
        let id = ShannonPresentationFace.latestID(in: conversation.messages)
        content
            .onAppear { show(id) }
            .onChange(of: id) { _, newID in show(newID) }
    }

    @MainActor private func show(_ id: String?) {
        appIcon.showFace(presentationId: id)
        ShannonDesktopMenuBar.shared.showFace(presentationId: id)
    }
}

public extension View {
    /// The Mac app's Dock and menu-bar face (`ShannonResidentFaceModifier`).
    func shannonResidentFace(conversation: ShannonConversationModel, appIcon: ShannonAppIconModel) -> some View {
        modifier(ShannonResidentFaceModifier(conversation: conversation, appIcon: appIcon))
    }
}
#endif
