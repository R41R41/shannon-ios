import SwiftUI

public struct ShannonWaterlightEyeView: View {
    public let expression: ShannonExpressionDTO
    public let size: CGFloat
    public let reactionTrigger: Int

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startedAt = Date()
    @State private var transitionOrigin: ShannonEyeStyle?
    @State private var transitionStartedAt: Date?
    @State private var reactionOrigin: ShannonEyeStyle?
    @State private var reactionStartedAt: Date?
    @State private var reducedMotionReactionActive = false

    public init(
        expression: ShannonExpressionDTO,
        size: CGFloat = 96,
        reactionTrigger: Int = 0
    ) {
        self.expression = expression
        self.size = size
        self.reactionTrigger = reactionTrigger
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        Group {
            if reduceMotion {
                waterlightCanvas(at: startedAt, palette: palette, isAnimated: false)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    waterlightCanvas(at: timeline.date, palette: palette, isAnimated: true)
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
        .accessibilityLabel(expression.accessibilityDescription)
        .onChange(of: expression) { oldExpression, _ in
            let now = Date()
            transitionOrigin = displayedStyle(for: oldExpression, at: now)
            transitionStartedAt = now
        }
        .onChange(of: reactionTrigger) { oldValue, newValue in
            guard oldValue != newValue else { return }
            let now = Date()
            reactionOrigin = renderedSample(at: now).style
            reactionStartedAt = now
        }
        .task(id: reactionTrigger) {
            guard reactionTrigger > 0, reduceMotion else { return }
            reducedMotionReactionActive = true
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            reducedMotionReactionActive = false
        }
    }

    private func waterlightCanvas(
        at date: Date,
        palette: ShannonPalette,
        isAnimated: Bool
    ) -> some View {
        let sample = renderedSample(at: date)
        return ShannonWaterlightCanvas(
            style: sample.style,
            elapsedTime: isAnimated ? max(0, date.timeIntervalSince(startedAt)) : 0,
            isAnimated: isAnimated,
            palette: palette,
            increasedContrast: colorSchemeContrast == .increased,
            blushOpacity: sample.blushOpacity
        )
    }

    private func renderedSample(at date: Date) -> ShannonEyeReactionSample {
        let base = displayedStyle(for: expression, at: date)
        if reduceMotion, reducedMotionReactionActive {
            return .init(style: ShannonEyeRig.style(for: .bashful), blushOpacity: 1)
        }
        guard !reduceMotion, let reactionOrigin, let reactionStartedAt else {
            return .init(style: base, blushOpacity: 0)
        }
        return ShannonEyeReactionTimeline.sample(
            origin: reactionOrigin,
            base: ShannonEyeRig.style(for: expression),
            elapsedTime: date.timeIntervalSince(reactionStartedAt)
        )
    }

    private func displayedStyle(
        for targetExpression: ShannonExpressionDTO,
        at date: Date
    ) -> ShannonEyeStyle {
        let target = ShannonEyeRig.style(for: targetExpression)
        guard !reduceMotion, let transitionOrigin, let transitionStartedAt else { return target }
        let progress = date.timeIntervalSince(transitionStartedAt) / ShannonEyeRig.transitionDuration
        guard progress < 1 else { return target }
        return transitionOrigin.blended(toward: target, progress: ShannonEyeRig.easeOutQuint(progress))
    }
}

private struct ShannonWaterlightCanvas: View {
    let style: ShannonEyeStyle
    let elapsedTime: TimeInterval
    let isAnimated: Bool
    let palette: ShannonPalette
    let increasedContrast: Bool
    let blushOpacity: Double

    var body: some View {
        Canvas(opaque: false, colorMode: .linear, rendersAsynchronously: true) { context, canvasSize in
            draw(in: &context, canvasSize: canvasSize)
        }
    }

    private func draw(in context: inout GraphicsContext, canvasSize: CGSize) {
        let frame = ShannonEyeRig.frame(style: style, elapsedTime: elapsedTime, isAnimated: isAnimated)
        let side = min(canvasSize.width, canvasSize.height)
        let radius = side * 0.47
        let center = CGPoint(
            x: canvasSize.width / 2 + frame.driftX * radius,
            y: canvasSize.height / 2 + frame.driftY * radius
        )
        let bodyRect = CGRect(
            x: center.x - radius,
            y: center.y - radius * frame.breath,
            width: radius * 2,
            height: radius * 2 * frame.breath
        )
        let bodyPath = Path(roundedRect: bodyRect, cornerRadius: side * 0.22)

        context.fill(bodyPath, with: .color(palette.intelligenceInk))
        context.stroke(
            bodyPath,
            with: .linearGradient(
                Gradient(colors: [
                    palette.intelligenceSky.opacity(increasedContrast ? 0.90 : 0.55),
                    palette.brandPresence.opacity(increasedContrast ? 0.72 : 0.34),
                    palette.intelligenceDepth.opacity(increasedContrast ? 0.86 : 0.58),
                ]),
                startPoint: CGPoint(x: bodyRect.minX, y: bodyRect.minY),
                endPoint: CGPoint(x: bodyRect.maxX, y: bodyRect.maxY)
            ),
            lineWidth: max(0.7, side / 78)
        )

        var clippedContext = context
        clippedContext.clip(to: bodyPath)
        drawCheeks(frame.eyes, center: center, radius: radius, in: &clippedContext)
        drawEyes(frame, bodyRect: bodyRect, center: center, radius: radius, in: &clippedContext)
    }

    private func drawCheeks(
        _ eyes: [ShannonEyeRig.ProjectedEye],
        center: CGPoint,
        radius: CGFloat,
        in context: inout GraphicsContext
    ) {
        guard blushOpacity > 0 else { return }
        for eye in eyes where eye.depth > 0.02 {
            let cheekWidth = radius * 0.34
            let cheekHeight = radius * 0.13
            let cheekRect = CGRect(
                x: center.x + eye.position.x * radius - cheekWidth / 2,
                y: center.y + eye.position.y * radius + radius * 0.08,
                width: cheekWidth,
                height: cheekHeight
            )
            context.fill(
                Path(roundedRect: cheekRect, cornerRadius: cheekHeight / 2),
                with: .color(palette.characterBlush.opacity(blushOpacity * 0.72))
            )
        }
    }

    private func drawEyes(
        _ frame: ShannonEyeRig.Frame,
        bodyRect: CGRect,
        center: CGPoint,
        radius: CGFloat,
        in context: inout GraphicsContext
    ) {
        for eye in frame.eyes where eye.depth > 0.02 {
            let eyeWidth = eye.configuration.width * radius * ShannonEyeRig.heroEyeScale
            let eyeHeight = eye.configuration.height * radius * ShannonEyeRig.heroEyeScale
            var eyePath = Path(
                roundedRect: CGRect(
                    x: -eyeWidth / 2,
                    y: -eyeHeight / 2,
                    width: eyeWidth,
                    height: eyeHeight
                ),
                cornerRadius: min(eyeWidth, eyeHeight) / 2
            )
            eyePath = eyePath.applying(transform(for: eye, center: center, radius: radius, lid: frame.lid))

            var eyeContext = context
            eyeContext.opacity = min(1, max(0, eye.depth / 0.12))
            eyeContext.fill(
                eyePath,
                with: .linearGradient(
                    Gradient(colors: [
                        palette.intelligenceSky,
                        palette.brandPresence,
                        palette.intelligenceDepth,
                    ]),
                    startPoint: CGPoint(x: bodyRect.minX, y: bodyRect.minY),
                    endPoint: CGPoint(x: bodyRect.maxX, y: bodyRect.maxY)
                )
            )
        }
    }

    private func transform(
        for eye: ShannonEyeRig.ProjectedEye,
        center: CGPoint,
        radius: CGFloat,
        lid: Double
    ) -> CGAffineTransform {
        let blinkScale = ShannonEyeRig.blinkScale(min(lid, eye.configuration.open))
        let tilt = eye.configuration.tilt * .pi / 180
        let cosine = cos(tilt)
        let sine = sin(tilt)
        let horizontalX = eye.horizontal.dx * cosine + eye.vertical.dx * sine
        let horizontalY = eye.horizontal.dy * cosine + eye.vertical.dy * sine
        let verticalX = -eye.horizontal.dx * sine + eye.vertical.dx * cosine
        let verticalY = -eye.horizontal.dy * sine + eye.vertical.dy * cosine
        return CGAffineTransform(
            a: horizontalX,
            b: horizontalY * blinkScale,
            c: verticalX,
            d: verticalY * blinkScale,
            tx: center.x + eye.position.x * radius,
            ty: center.y + eye.position.y * radius
        )
    }
}
