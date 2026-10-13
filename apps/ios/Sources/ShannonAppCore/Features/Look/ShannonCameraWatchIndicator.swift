import SwiftUI

/// 「見ています」 (Syzygy ADR-0011 §4.4): on screen for as long as the camera watches, apart from the system's camera
/// light, with 「止める」 in one tap. For a moment after a frame was sent it says 「いま見ました」. After 「止める」 it says
/// so and offers 「再開」; when watching stopped by itself it says why for a few seconds.
struct ShannonCameraWatchIndicator: View {
    let watch: ShannonCameraWatchCoordinator

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var title: String {
        if watch.isWatching { return watch.lookedCue == nil ? ShannonCameraWatchCopy.watching : ShannonAppLookCopy.cueTitle }
        if watch.stoppedByOwner { return ShannonCameraWatchCopy.stoppedByOwner }
        return watch.notice ?? ""
    }

    private var symbol: String {
        guard watch.isWatching else { return "eye.slash" }
        return watch.lookedCue == nil ? "eye" : "eye.fill"
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        HStack(spacing: ShannonSpacing.small) {
            Label(title, systemImage: symbol)
                .font(.shannon(.footnote).weight(.semibold))
                .foregroundStyle(watch.isWatching ? palette.textPrimary : palette.textSecondary)
                .lineLimit(2)
                .accessibilityLabel(watch.isWatching ? ShannonCameraWatchCopy.watchingAccessibility : title)
                .accessibilityIdentifier("camera-watch-state")
            if watch.isWatching {
                action(ShannonCameraWatchCopy.stop, hint: ShannonCameraWatchCopy.stopHint, id: "camera-watch-stop", palette: palette) {
                    watch.stopByOwner()
                }
            } else if watch.stoppedByOwner {
                action(ShannonCameraWatchCopy.resume, hint: ShannonCameraWatchCopy.resumeHint, id: "camera-watch-resume", palette: palette) {
                    watch.resumeByOwner()
                }
            }
        }
        .padding(.leading, ShannonSpacing.medium)
        .padding(.trailing, ShannonSpacing.small)
        .frame(minHeight: ShannonTouchTarget.minimum)
        .background {
            let shape = Capsule()
            if reduceTransparency { shape.fill(palette.elevatedSurface) } else { shape.fill(.regularMaterial) }
        }
        .overlay { Capsule().stroke(palette.divider.opacity(0.7), lineWidth: 0.7) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("camera-watch-indicator")
    }

    private func action(
        _ title: String, hint: String, id: String, palette: ShannonPalette, perform: @escaping () -> Void
    ) -> some View {
        Button(title, action: perform)
            .font(.shannon(.footnote).weight(.semibold))
            .buttonStyle(.borderless)
            .foregroundStyle(palette.action)
            .padding(.horizontal, ShannonSpacing.small)
            .frame(minWidth: ShannonTouchTarget.minimum, minHeight: ShannonTouchTarget.minimum)
            .contentShape(Rectangle())
            .accessibilityHint(hint)
            .accessibilityIdentifier(id)
    }
}

/// Lets the conversation's surroundings feed watching: who may be listening (「友人も一緒」, a recent companion, the Mac's
/// stream output), and her reaction to what she saw, shown on her Live2D figure and her face through the usual path.
struct ShannonCameraWatchBodyLink: ViewModifier {
    let watch: ShannonCameraWatchCoordinator
    let bodyModel: ShannonBodyModel
    let othersPresent: Bool
    let usesLive2D: Bool

    /// The face before a reaction, put back when the reaction ends unless something else changed it meanwhile.
    @State private var faceBefore: ShannonFace?
    @State private var shownFace: ShannonFace?

    func body(content: Content) -> some View {
        content
            .onChange(of: othersPresent, initial: true) { watch.setOthersPresent(othersPresent) }
            .onChange(of: watch.reaction) { show(watch.reaction) }
    }

    private func show(_ reaction: ShannonCameraWatchCoordinator.Reaction?) {
        guard let reaction else {
            if let faceBefore, bodyModel.face == shownFace { bodyModel.face = faceBefore }
            faceBefore = nil
            shownFace = nil
            return
        }
        if faceBefore == nil { faceBefore = bodyModel.face }
        let face = ShannonFace(expression: reaction.expression)
        shownFace = face
        bodyModel.face = face
        if usesLive2D {
            // The page returns to her mood's face by itself after these seconds.
            ShannonLive2DStage.shared.express(reaction.expression.rawValue, seconds: ShannonCameraWatchCoordinator.reactionSeconds)
        }
    }
}
