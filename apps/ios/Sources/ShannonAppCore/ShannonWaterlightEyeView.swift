import SwiftUI

public struct ShannonWaterlightEyeView: View {
    public let expression: ShannonExpressionDTO
    public let activity: ShannonDialogueActivity
    public let size: CGFloat
    public let reactionTrigger: Int
    public let allowsTracking: Bool
    /// A core feeling that borrows this expression's eye shape; it changes only the spoken name.
    public let feeling: ShannonFeelingDTO?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startedAt = Date()
    @State private var activityStartedAt = Date()
    @State private var transitionOrigin: ShannonEyeStyle?
    @State private var transitionStartedAt: Date?
    @State private var reactionOrigin: ShannonEyeStyle?
    @State private var reactionStartedAt: Date?
    @State private var reducedMotionReactionActive = false
    @State private var localReactionTrigger = 0
    @State private var trackingPoint: CGPoint?
    @GestureState private var isPressed = false

    public init(
        expression: ShannonExpressionDTO,
        activity: ShannonDialogueActivity = .idle,
        size: CGFloat = 96,
        reactionTrigger: Int = 0,
        allowsTracking: Bool = true,
        feeling: ShannonFeelingDTO? = nil
    ) {
        self.expression = expression
        self.activity = activity
        self.size = size
        self.reactionTrigger = reactionTrigger
        self.allowsTracking = allowsTracking
        self.feeling = feeling
    }
    public var body: some View {
        Group {
            if reduceMotion {
                waterlightCanvas(at: startedAt, isAnimated: false)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
                    waterlightCanvas(at: timeline.date, isAnimated: true)
                }
            }
        }
        .frame(width: size, height: size)
        .shadow(
            color: .black.opacity(colorScheme == .dark ? 0.34 : 0.16),
            radius: size / 13,
            y: size / 30
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(ShannonFace(expression: expression, feeling: feeling).accessibilityDescription)、\(activity.japaneseLabel)"
        )
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { triggerReaction() }
        .simultaneousGesture(faceGesture)
        .onChange(of: expression) { oldExpression, _ in
            let now = Date()
            transitionOrigin = displayedStyle(for: oldExpression, activity: activity, at: now)
            transitionStartedAt = now
        }
        .onChange(of: activity) { oldActivity, _ in
            let now = Date()
            transitionOrigin = displayedStyle(for: expression, activity: oldActivity, at: now)
            transitionStartedAt = now
            activityStartedAt = now
        }
        .onChange(of: reactionTrigger) { oldValue, newValue in
            guard oldValue != newValue else { return }
            beginReaction()
        }
        .task(id: reactionTrigger &+ localReactionTrigger) {
            guard reactionTrigger > 0 || localReactionTrigger > 0, reduceMotion else { return }
            reducedMotionReactionActive = true
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            reducedMotionReactionActive = false
        }
    }

    private func waterlightCanvas(
        at date: Date,
        isAnimated: Bool
    ) -> some View {
        let sample = renderedSample(at: date)
        let activityTime = max(0, date.timeIntervalSince(activityStartedAt))
        let pose = ShannonEyeRig.pose(
            for: expression,
            activity: activity,
            elapsedTime: activityTime,
            isAnimated: isAnimated,
            tracking: trackingPoint
        )
        let frame = ShannonEyeRig.frame(
            pose: .init(
                style: sample.style,
                energy: pose.energy,
                decor: pose.decor,
                blinkProfile: pose.blinkProfile
            ),
            elapsedTime: isAnimated ? max(0, date.timeIntervalSince(startedAt)) : 0,
            isAnimated: isAnimated
        )
        return ShannonWaterlightCanvas(
            frame: frame,
            increasedContrast: colorSchemeContrast == .increased,
            blushOpacity: sample.blushOpacity
        )
        .offset(
            x: isAnimated ? frame.gaze.yaw * size * 0.00075 : 0,
            y: isAnimated ? -frame.gaze.pitch * size * 0.00050 : 0
        )
        .rotation3DEffect(
            .degrees(isAnimated ? -frame.gaze.pitch * 0.095 : 0),
            axis: (x: 1, y: 0, z: 0),
            perspective: 0.62
        )
        .rotation3DEffect(
            .degrees(isAnimated ? frame.gaze.yaw * 0.095 : 0),
            axis: (x: 0, y: 1, z: 0),
            perspective: 0.62
        )
        .rotationEffect(.degrees(isAnimated ? frame.gaze.roll * 0.08 : 0))
        .scaleEffect((isAnimated && isPressed ? 0.975 : 1) * frame.breath)
    }

    private func renderedSample(at date: Date) -> ShannonEyeReactionSample {
        let base = displayedStyle(for: expression, activity: activity, at: date)
        let baseBlush = ShannonEyeRig.hasPersistentBlush(expression) ? 0.40 : 0
        if reduceMotion, reducedMotionReactionActive {
            return .init(style: ShannonEyeRig.style(for: .bashful), blushOpacity: 0.40)
        }
        guard !reduceMotion, let reactionOrigin, let reactionStartedAt else {
            return .init(style: base, blushOpacity: baseBlush)
        }
        let reaction = ShannonEyeReactionTimeline.sample(
            origin: reactionOrigin,
            base: base,
            elapsedTime: date.timeIntervalSince(reactionStartedAt)
        )
        return .init(style: reaction.style, blushOpacity: max(baseBlush, reaction.blushOpacity))
    }

    private func displayedStyle(
        for targetExpression: ShannonExpressionDTO,
        activity targetActivity: ShannonDialogueActivity,
        at date: Date
    ) -> ShannonEyeStyle {
        let target = ShannonEyeRig.pose(
            for: targetExpression,
            activity: targetActivity,
            elapsedTime: max(0, date.timeIntervalSince(activityStartedAt)),
            isAnimated: !reduceMotion,
            tracking: trackingPoint
        ).style
        guard !reduceMotion, let transitionOrigin, let transitionStartedAt else { return target }
        let progress = date.timeIntervalSince(transitionStartedAt) / ShannonEyeRig.transitionDuration
        guard progress < 1 else { return target }
        return transitionOrigin.blended(toward: target, progress: ShannonEyeRig.easeOutQuint(progress))
    }

    private var faceGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($isPressed) { _, isPressed, _ in
                guard !reduceMotion else { return }
                isPressed = true
            }
            .onChanged { value in
                guard allowsTracking, !reduceMotion else { return }
                trackingPoint = CGPoint(
                    x: ((value.location.x / max(1, size)) - 0.5) * 2,
                    y: ((value.location.y / max(1, size)) - 0.5) * 2
                )
            }
            .onEnded { _ in
                trackingPoint = nil
                triggerReaction()
            }
    }

    private func triggerReaction() {
        localReactionTrigger &+= 1
        beginReaction()
    }

    private func beginReaction() {
        let now = Date()
        reactionOrigin = renderedSample(at: now).style
        reactionStartedAt = now
    }
}
