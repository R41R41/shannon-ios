import SwiftUI

/// Her figure in Talk's dialogue display in the Live2D form (decision 2026-10-03: からだ is a display
/// of Talk). What the body screen 「からだ」 held for the figure is here: she is large and touchable in
/// place, two fingers scale and move her (with VoiceOver: direct touch, and a swipe up or down for her
/// size), her line for a touch shows above her, and a short truthful note says when the page loads,
/// fails, rests or is shown elsewhere. The Waterlight Eye stands in while the Live2D page is not here.
/// Her form, 映し方 and 位置を戻す are in Talk's display options and in 設定 › すがた.
struct ShannonDialogueFigure: View {
    let face: ShannonFace
    let activity: ShannonDialogueActivity

    @AppStorage(ShannonBodyPreference.layoutModeKey) private var layoutModeRawValue = ShannonLive2DLayout.Mode.full.rawValue
    @State private var hostID = UUID()
    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var stage: ShannonLive2DStage { .shared }
    private var showsLive2D: Bool { ShannonLive2DStage.isAvailable && stage.status == .ready && stage.activeHost == hostID }
    private var adjustment: ShannonLive2DLayout { bodyModel?.figureAdjustment ?? ShannonLive2DLayout() }

    private var layout: ShannonLive2DLayout {
        ShannonLive2DLayout(
            mode: ShannonLive2DLayout.Mode(rawValue: layoutModeRawValue) ?? .full,
            scale: adjustment.scale, offsetX: adjustment.offsetX, offsetY: adjustment.offsetY,
            // 上半身 is fitted to the width as well: on a tall frame the height alone would cut her shoulders.
            contained: layoutModeRawValue == ShannonLive2DLayout.Mode.bust.rawValue
        )
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        GeometryReader { geometry in
            ZStack {
                if !showsLive2D {
                    ShannonWaterlightEyeView(
                        expression: face.expression, activity: activity,
                        size: min(geometry.size.width * 0.62, geometry.size.height * 0.8, 260), feeling: face.feeling
                    )
                    .transition(.opacity)
                }
                if ShannonLive2DStage.isAvailable {
                    ShannonLive2DFigure(
                        hostID: hostID, priority: .dialogue, layout: layout, touchEnabled: true, face: face, activity: activity,
                        isShowing: showsLive2D,
                        onLayoutChange: { bodyModel?.figureAdjustment = $0 },
                        directTouch: true,
                        onAdjust: { larger in
                            bodyModel?.figureAdjustment = adjustment.adjusted(scaleBy: larger ? 1.25 : 0.8, movedBy: .zero, in: geometry.size)
                        }
                    )
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: showsLive2D)
            .overlay(alignment: .top) {
                if showsLive2D {
                    ShannonBodyLineBubble(maxWidth: min(340, geometry.size.width - 2 * ShannonSpacing.large))
                        .padding(.top, ShannonSpacing.small)
                }
            }
            .overlay(alignment: .bottom) { status(palette) }
        }
#if DEBUG
        .onAppear { if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewBodyStats") { stage.setFrameStats(true) } }
        .onDisappear { stage.setFrameStats(false) }
#endif
    }

    /// A small, truthful note about the Live2D form; nothing while it simply works.
    @ViewBuilder
    private func status(_ palette: ShannonPalette) -> some View {
        if let text = statusText {
            VStack(spacing: ShannonSpacing.extraSmall) {
                Text(text)
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.textSecondary)
                    .multilineTextAlignment(.center)
                if stage.status == .failed {
                    Button(ShannonBodyCopy.retry) { stage.retry() }
                        .font(.shannon(.footnote).weight(.semibold))
                        .frame(minHeight: ShannonTouchTarget.minimum)
                }
            }
            .padding(.horizontal, ShannonSpacing.medium)
            .padding(.vertical, ShannonSpacing.extraSmall)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
            .padding(.bottom, ShannonSpacing.small)
            .accessibilityIdentifier("dialogue-live2d-status")
        }
    }

    private var statusText: String? {
        guard ShannonLive2DStage.isAvailable else { return ShannonBodyCopy.unavailable }
        switch stage.status {
        case .failed: return ShannonBodyCopy.failed
        case .loading, .unloaded: return ShannonBodyCopy.loading(progress: stage.loadProgress)
        case .ready:
            if stage.activeHost != hostID { return ShannonBodyCopy.shownElsewhere }
            if stage.isResting { return stage.lowPower ? ShannonBodyCopy.resting : ShannonBodyCopy.restingReduceMotion }
#if DEBUG
            if let fps = stage.framesPerSecond {
                return "\(fps) fps・読み込み \(String(format: "%.1f", stage.lastLoadSeconds ?? 0)) 秒・\(stage.modelUpdatedAt ?? "")"
            }
#endif
            return nil
        }
    }
}
