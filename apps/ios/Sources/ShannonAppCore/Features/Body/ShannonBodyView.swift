import SwiftUI

/// Shannon's figure in the form the owner chose: the Waterlight Eye, or the Live2D character.
/// Used where her figure is the subject of the screen. The frame is the same square in both
/// forms, and the Waterlight Eye stands in while the Live2D page loads, fails, or is being
/// shown by another screen, so switching never moves the layout.
public struct ShannonBodyView: View {
    public let expression: ShannonExpressionDTO
    public let activity: ShannonDialogueActivity
    public let size: CGFloat
    public let reactionTrigger: Int
    public let allowsTracking: Bool
    public let feeling: ShannonFeelingDTO?
    /// Live2D only: whether a finger on her reaches the page. Off where the figure is a button.
    public let allowsTouch: Bool
    /// Live2D only: whether her line for a touch is shown above this figure.
    public let showsLine: Bool
    /// Live2D only: which screen shows the one figure when several are on screen.
    public let priority: ShannonLive2DHostPriority

    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @State private var hostID = UUID()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        expression: ShannonExpressionDTO,
        activity: ShannonDialogueActivity = .idle,
        size: CGFloat = 96,
        reactionTrigger: Int = 0,
        allowsTracking: Bool = true,
        feeling: ShannonFeelingDTO? = nil,
        allowsTouch: Bool = true,
        showsLine: Bool = true,
        priority: ShannonLive2DHostPriority = .dialogue
    ) {
        self.expression = expression
        self.activity = activity
        self.size = size
        self.reactionTrigger = reactionTrigger
        self.allowsTracking = allowsTracking
        self.feeling = feeling
        self.allowsTouch = allowsTouch
        self.showsLine = showsLine
        self.priority = priority
    }

    public var body: some View {
        let stage = ShannonLive2DStage.shared
        let usesLive2D = formRawValue == ShannonForm.live2d.rawValue && ShannonLive2DStage.isAvailable
        let showsLive2D = usesLive2D && stage.status == .ready && stage.activeHost == hostID

        ZStack {
            if !showsLive2D {
                ShannonWaterlightEyeView(
                    expression: expression, activity: activity, size: size,
                    reactionTrigger: reactionTrigger, allowsTracking: allowsTracking, feeling: feeling
                )
                .transition(.opacity)
            }
            if usesLive2D {
                ShannonLive2DFigure(
                    hostID: hostID, priority: priority, layout: Self.squareLayout, touchEnabled: allowsTouch,
                    face: ShannonFace(expression: expression, feeling: feeling), activity: activity,
                    isShowing: showsLive2D
                )
                // The square cuts her at the waist and may cut long hair at the sides: the edges fade instead of ending in a line.
                .mask(ShannonFigureFade())
            }
        }
        .frame(width: size, height: size)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: showsLive2D)
        .overlay(alignment: .top) {
            if showsLine, showsLive2D {
                ShannonBodyLineBubble(maxWidth: max(220, size))
                    .alignmentGuide(.top) { $0[.bottom] + ShannonSpacing.small }
            }
        }
    }

    /// Head to waist, fitted to the width too, so that hair and shoulders stay inside the square.
    static let squareLayout = ShannonLive2DLayout(mode: .bust, contained: true)
}

/// The Live2D figure in one place. It is always in the hierarchy while the Live2D form is chosen
/// (that is how the stage knows a screen wants her) and visible once the page is ready here.
struct ShannonLive2DFigure: View {
    let hostID: UUID
    let priority: ShannonLive2DHostPriority
    let layout: ShannonLive2DLayout
    let touchEnabled: Bool
    let face: ShannonFace
    let activity: ShannonDialogueActivity
    let isShowing: Bool
    var onLayoutChange: ((ShannonLive2DLayout) -> Void)?
    /// The body screen: with VoiceOver on, fingers on this element go straight to her, and she can be made larger or smaller.
    var directTouch = false
    var onAdjust: ((_ larger: Bool) -> Void)?

    /// 設定 › すがた › 体. Every place that wants her figure says the chosen body to the one page.
    @AppStorage(ShannonLive2DBody.storageKey) private var bodyRawValue = ShannonLive2DBody.human.rawValue

    private func applyBody() {
        ShannonLive2DStage.shared.setBody(ShannonLive2DBody(rawValue: bodyRawValue) ?? .human)
    }

    var body: some View {
        let figure = ShannonLive2DHostView(hostID: hostID, priority: priority, layout: layout, touchEnabled: touchEnabled, onLayoutChange: onLayoutChange)
            .onAppear(perform: applyBody)
            .onChange(of: bodyRawValue) { applyBody() }
            .opacity(isShowing ? 1 : 0)
            .allowsHitTesting(isShowing && touchEnabled)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(face.accessibilityDescription)、\(activity.japaneseLabel)")
            .accessibilityHint(touchEnabled ? (directTouch ? ShannonBodyCopy.figureDirectHint : ShannonBodyCopy.figureHint) : "")
            .accessibilityAddTraits(.isImage)
            .accessibilityHidden(!isShowing)
        if let onAdjust {
            figure
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: onAdjust(true)
                    case .decrement: onAdjust(false)
                    @unknown default: break
                    }
                }
                .accessibilityValue(String(format: "%d%%", Int((layout.scale * 100).rounded())))
                .modifier(ShannonDirectTouch(enabled: directTouch && touchEnabled))
        } else {
            figure
        }
    }
}

private struct ShannonDirectTouch: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
#if os(iOS)
        content.accessibilityDirectTouch(enabled, options: [])
#else
        content
#endif
    }
}

/// Her one line for a touch, near the figure. Shown, not spoken.
struct ShannonBodyLineBubble: View {
    var maxWidth: CGFloat = 320

    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let line = bodyModel?.touch.line
        Group {
            if let line {
                Text(line.text)
                    .font(.shannon(.callout))
                    .foregroundStyle(palette.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, ShannonSpacing.large)
                    .padding(.vertical, ShannonSpacing.medium)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(palette.divider.opacity(0.62), lineWidth: 0.7)
                    }
                    .shadow(color: .black.opacity(0.10), radius: 10, y: 4)
                    .accessibilityLabel("シャノン：\(line.text)")
                    .transition(.opacity)
                    .id(line.id)
            }
        }
        // A fixed width, so the bubble may be wider than a small figure and its text still wraps.
        .frame(width: maxWidth)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: line)
        .onChange(of: line) {
            // Her voice says a spoken line; VoiceOver does not say it over her.
            guard let line, !line.isSpoken else { return }
            AccessibilityNotification.Announcement("シャノン：\(line.text)").post()
        }
        .allowsHitTesting(false)
    }
}

/// Opaque in the middle, fading out towards the bottom and a little towards the sides.
private struct ShannonFigureFade: View {
    var body: some View {
        LinearGradient(
            stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.84), .init(color: .clear, location: 1)],
            startPoint: .top, endPoint: .bottom
        )
        .mask(LinearGradient(
            stops: [
                .init(color: .clear, location: 0), .init(color: .black, location: 0.07),
                .init(color: .black, location: 0.93), .init(color: .clear, location: 1),
            ],
            startPoint: .leading, endPoint: .trailing
        ))
    }
}
