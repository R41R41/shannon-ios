import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// What a message's small icon shows, read from that message's own feeling (`messageEmotion`, kept as
/// `ConversationMessage.EmotionSnapshot`). The server already resolved the reply's kind or borrowed feeling to
/// one of the 22 faces (`faceForEmotionKind`), so the label beside 「シャノン」 and the icon read the same face.
/// A message without a feeling shows the usual face.
public enum ShannonMessageAvatarMood {
    public static func face(for emotion: ConversationMessage.EmotionSnapshot?) -> ShannonFace {
        emotion?.face ?? ShannonFace(expression: .neutral)
    }

    /// The Waterlight eye shape for a message: the face's expression (`uncomfortable` already reads as `annoyed`).
    public static func eyeExpression(for emotion: ConversationMessage.EmotionSnapshot?) -> ShannonExpressionDTO {
        face(for: emotion).expression
    }

    /// The pre-rendered face picture the close-up crops: the kind's own picture when bundled, else the face's.
    static func faceAssetName(for emotion: ConversationMessage.EmotionSnapshot?) -> String {
        ShannonExpressionAssets.assetName(for: face(for: emotion))
    }
}

/// The small icon beside 「シャノン」 in a message (iPhone and Mac Talk), with no tile or frame: her eyes alone
/// for the eye icon (ボット), a close-up of her face for the expression icon (ガール). Both change with the
/// message's feeling. VoiceOver reads the feeling's name, as before.
///
/// A reply with a presentation id (Syzygy ADR-0013 D17) shows the face it was shown with, from that id
/// (`ShannonPresentationFace`); without one, the face of its feeling as before.
public struct ShannonMessageAvatarView: View {
    public let face: ShannonFace
    public let size: CGFloat
    /// The reply's presentation id; nil shows `face`.
    public var presentationID: String?

    @AppStorage(ShannonChatAvatarStyle.storageKey) private var styleRawValue = ShannonChatAvatarStyle.expression.rawValue
    @AppStorage(ShannonPersonaPreset.storageKey) private var presetRawValue = ShannonPersonaPreset.initialRawValue

    public init(face: ShannonFace, size: CGFloat = 30) {
        self.face = face
        self.size = size
    }

    public init(emotion: ConversationMessage.EmotionSnapshot?, size: CGFloat = 30) {
        self.init(face: ShannonMessageAvatarMood.face(for: emotion), size: size)
        presentationID = emotion?.presentationId
    }

    public var body: some View {
        Group {
            if style == .secondAppIcon {
                ShannonMessageEyesView(expression: presentationID.map(ShannonPresentationFace.eyeExpression(for:)) ?? face.expression, size: size)
            } else if let presentationID {
                ShannonPresentationFaceView(id: presentationID, size: size)
            } else {
                ShannonMessageFaceCloseUp(face: face, size: size)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentationID.map { "シャノン、\(ShannonPresentationFace.japaneseName(for: $0))" } ?? face.accessibilityDescription)
    }

    /// The one 「ボット／ガール」 choice decides it; individual settings keep their own avatar style.
    private var style: ShannonChatAvatarStyle {
        ShannonPersonaPreset(rawValue: presetRawValue)?.avatarStyle
            ?? ShannonChatAvatarStyle(rawValue: styleRawValue)
            ?? .expression
    }
}

/// Her Waterlight eyes alone, still, zoomed so the expression reads at message size.
struct ShannonMessageEyesView: View {
    let expression: ShannonExpressionDTO
    let size: CGFloat

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast

    var body: some View {
        let pose = ShannonEyeRig.pose(for: expression, activity: .idle, elapsedTime: 0, isAnimated: false)
        let frame = ShannonEyeRig.frame(pose: pose, elapsedTime: 0, isAnimated: false)
        ShannonWaterlightCanvas(
            frame: frame,
            increasedContrast: colorSchemeContrast == .increased,
            blushOpacity: ShannonEyeRig.hasPersistentBlush(expression) ? 0.40 : 0,
            eyesOnly: true,
            outlinesEyes: colorScheme == .light
        )
        .frame(width: size, height: size)
    }
}

/// A close-up of her face from the pre-rendered face pictures (one per face and per kind, same framing), cropped
/// to the face so the expression reads at message size. A Live2D figure per row would be one web view per
/// message; the pictures are the same faces, already in the bundle.
struct ShannonMessageFaceCloseUp: View {
    let face: ShannonFace
    let size: CGFloat

    /// The face pictures share one framing: the face sits around the middle, slightly below centre.
    static let zoom: CGFloat = 2.0
    static let faceAnchor = UnitPoint(x: 0.5, y: 0.60)

    var body: some View {
        picture
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .scaleEffect(Self.zoom, anchor: Self.faceAnchor)
            .frame(width: size, height: size)
            .clipShape(Circle())
    }

    private var picture: Image {
#if canImport(UIKit)
        if let image = ShannonExpressionAssets.uiImage(forAsset: ShannonExpressionAssets.assetName(for: face))
            ?? ShannonExpressionAssets.uiImage(for: face.expression) {
            return Image(uiImage: image)
        }
#elseif canImport(AppKit)
        if let image = ShannonExpressionAssets.nsImage(forAsset: ShannonExpressionAssets.assetName(for: face))
            ?? ShannonExpressionAssets.nsImage(for: face.expression) {
            return Image(nsImage: image)
        }
#endif
        return Image(systemName: "person.crop.circle.fill")
    }
}
