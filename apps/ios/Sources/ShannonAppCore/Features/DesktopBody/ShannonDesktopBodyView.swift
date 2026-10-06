#if os(macOS)
import SwiftUI

/// What her desktop window draws: her figure (the one Live2D web view, moved here by the stage), her words above her,
/// and the camera's state at her feet. The window itself is transparent and borderless; nothing here takes the
/// pointer except her figure (`ShannonDesktopBodyWindowController` lets every other click through).
/// Her window's two parts: her words above, and the stage at the bottom, `stageHeight` high (less only when the
/// window is lower). The stage never moves: a line taller than the room above her spills upward out of the words'
/// area instead of pushing the stage down, so the window controller's mask and grip zones (`stageRect`) stay true.
struct ShannonDesktopBodyColumn<Words: View, Stage: View>: View {
    let stageHeight: CGFloat
    @ViewBuilder let words: () -> Words
    @ViewBuilder let stage: () -> Stage

    var body: some View {
        VStack(spacing: 0) {
            words()
                .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .bottom)
            stage()
                .frame(maxWidth: .infinity, maxHeight: stageHeight)
                .layoutPriority(1)
        }
    }
}

struct ShannonDesktopBodyView: View {
    let model: ShannonDesktopBody
    let hostID: UUID

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var stage: ShannonLive2DStage { .shared }
    private var showsLive2D: Bool { ShannonLive2DStage.isAvailable && stage.status == .ready && stage.activeHost == hostID }
    /// Full length, fitted to the stage: she stands in her window as on the Windows desktop.
    private static let layout = ShannonLive2DLayout(mode: .full, contained: true)

    var body: some View {
        // Sized from her scale, not read from a GeometryReader around the Live2D host (see DesktopWidthAdaptive):
        // her window is made at this size (`ShannonDesktopBodyGeometry.windowSize`).
        let scale = ShannonDesktopBodyGeometry.clampScale(model.scale)
        let stageHeight = (ShannonDesktopBodyGeometry.stageHeight * scale).rounded()
        ShannonDesktopBodyColumn(stageHeight: stageHeight) {
            words
        } stage: {
            ZStack(alignment: .bottom) {
                if !showsLive2D {
                    ShannonWaterlightEyeView(
                        expression: .calm,
                        size: min(max(ShannonDesktopBodyGeometry.minimumWidth, ShannonDesktopBodyGeometry.baseWidth * scale) * 0.5, stageHeight * 0.4),
                        allowsTracking: false
                    )
                    .frame(maxHeight: .infinity)
                }
                // Only while she is shown: a hidden window gives the figure back to the app's other places.
                if model.isShown, ShannonLive2DStage.isAvailable {
                    ShannonLive2DHostView(hostID: hostID, priority: .desktop, layout: Self.layout, touchEnabled: true)
                        .opacity(showsLive2D ? 1 : 0)
                }
                cameraMark
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ShannonGeneratedStrings.desktopBodyFigure)
    }

    /// Her words, above her head: one of her messages, a line of a moment, what she said about the room, or her line
    /// for a touch. VoiceOver reads a line her voice does not say.
    private var words: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let line = model.touch.line ?? model.line
        return Group {
            if let line {
                Text(line.text)
                    .font(.shannonDesktop(.body))
                    .foregroundStyle(palette.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, ShannonDesktopSpacing.large)
                    .padding(.vertical, ShannonDesktopSpacing.medium)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.large, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: ShannonDesktopRadius.large, style: .continuous)
                            .stroke(palette.divider.opacity(0.62), lineWidth: 0.7)
                    }
                    .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
                    // Within the window's own width, whatever her scale asked for: the column proposes it.
                    .padding(.horizontal, ShannonDesktopSpacing.large)
                    .padding(.bottom, ShannonDesktopSpacing.small)
                    .accessibilityLabel("シャノン：\(line.text)")
                    .transition(.opacity)
                    .id(line.id)
                    .onAppear {
                        guard !line.isSpoken else { return }
                        AccessibilityNotification.Announcement("シャノン：\(line.text)").post()
                    }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: line)
        .allowsHitTesting(false)
    }

    /// 「カメラ：切／見てよい／いま見ています」 at her feet, always (Syzygy ADR-0002); stronger while the camera is open.
    private var cameraMark: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let state = model.cameraState
        return Label(state.line, systemImage: state.symbol)
            .font(.shannonDesktop(.caption2).weight(state == .looking ? .semibold : .regular))
            .foregroundStyle(state == .looking ? palette.textPrimary : palette.textSecondary)
            .lineLimit(1)
            .padding(.horizontal, ShannonDesktopSpacing.small)
            .padding(.vertical, 2)
            .background(.thinMaterial, in: Capsule())
            .opacity(state == .looking ? 1 : 0.78)
            .fixedSize()
            .padding(.bottom, 2)
            .allowsHitTesting(false)
            .accessibilityLabel(state.line)
            .accessibilityIdentifier("desktop-body-camera-state")
    }
}
#endif
