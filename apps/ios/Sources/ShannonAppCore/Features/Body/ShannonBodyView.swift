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
        showsLine: Bool = true
    ) {
        self.expression = expression
        self.activity = activity
        self.size = size
        self.reactionTrigger = reactionTrigger
        self.allowsTracking = allowsTracking
        self.feeling = feeling
        self.allowsTouch = allowsTouch
        self.showsLine = showsLine
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
                    hostID: hostID, layout: Self.squareLayout, touchEnabled: allowsTouch,
                    face: ShannonFace(expression: expression, feeling: feeling), activity: activity,
                    isShowing: showsLive2D
                )
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

    /// Head to waist, a little smaller than the page's own fit so that hair and shoulders stay inside the square.
    static let squareLayout = ShannonLive2DLayout(mode: .bust, scale: 0.92)
}

/// The Live2D figure in one place. It is always in the hierarchy while the Live2D form is chosen
/// (that is how the stage knows a screen wants her) and visible once the page is ready here.
struct ShannonLive2DFigure: View {
    let hostID: UUID
    let layout: ShannonLive2DLayout
    let touchEnabled: Bool
    let face: ShannonFace
    let activity: ShannonDialogueActivity
    let isShowing: Bool
    var onLayoutChange: ((ShannonLive2DLayout) -> Void)?

    var body: some View {
        ShannonLive2DHostView(hostID: hostID, layout: layout, touchEnabled: touchEnabled, onLayoutChange: onLayoutChange)
            .opacity(isShowing ? 1 : 0)
            .allowsHitTesting(isShowing && touchEnabled)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(face.accessibilityDescription)、\(activity.japaneseLabel)")
            .accessibilityHint(touchEnabled ? ShannonBodyCopy.figureHint : "")
            .accessibilityAddTraits(.isImage)
            .accessibilityHidden(!isShowing)
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
                    .font(.callout)
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
            guard let line else { return }
            AccessibilityNotification.Announcement("シャノン：\(line.text)").post()
        }
        .allowsHitTesting(false)
    }
}
