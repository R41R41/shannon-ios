import SwiftUI

struct ShannonWaterlightCanvas: View {
    let frame: ShannonEyeRig.Frame
    let increasedContrast: Bool
    let blushOpacity: Double

    var body: some View {
        // The approved browser study and icon are authored in sRGB.
        Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, canvasSize in
            draw(in: &context, canvasSize: canvasSize)
        }
    }

    private func draw(in context: inout GraphicsContext, canvasSize: CGSize) {
        let side = min(canvasSize.width, canvasSize.height)
        let radius = side * ShannonWaterlightVisualTokens.bodyRadiusRatio
        let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
        let bodyRect = CGRect(
            x: center.x - radius,
            y: center.y - radius,
            width: radius * 2,
            height: radius * 2
        )
        let bodyPath = Path(
            roundedRect: bodyRect,
            cornerRadius: side * ShannonWaterlightVisualTokens.cornerRadiusRatio
        )
        let borderPath = Path(
            roundedRect: bodyRect.insetBy(
                dx: side * ShannonWaterlightVisualTokens.borderInsetRatio,
                dy: side * ShannonWaterlightVisualTokens.borderInsetRatio
            ),
            cornerRadius: side * ShannonWaterlightVisualTokens.borderCornerRadiusRatio
        )

        context.fill(
            bodyPath,
            with: .linearGradient(
                Gradient(colors: [
                    Color(hex: ShannonWaterlightVisualTokens.faceTop),
                    Color(hex: ShannonWaterlightVisualTokens.faceMiddle),
                    Color(hex: ShannonWaterlightVisualTokens.faceBottom),
                ]),
                startPoint: CGPoint(x: bodyRect.minX, y: bodyRect.minY),
                endPoint: CGPoint(x: bodyRect.maxX, y: bodyRect.maxY)
            )
        )
        context.stroke(
            borderPath,
            with: .color(
                Color(hex: ShannonWaterlightVisualTokens.border)
                    .opacity(increasedContrast ? 0.42 : 0.22)
            ),
            lineWidth: max(1, side * ShannonWaterlightVisualTokens.borderWidthRatio)
        )

        var clippedContext = context
        clippedContext.clip(to: bodyPath)
        drawTerminalSurface(bodyRect: bodyRect, side: side, in: &clippedContext)
        drawDecor(frame.decor, center: center, radius: radius, in: &clippedContext)
        drawCheeks(frame.eyes, center: center, radius: radius, in: &clippedContext)
        drawEyes(frame, bodyRect: bodyRect, center: center, radius: radius, in: &clippedContext)
    }

    private func drawTerminalSurface(
        bodyRect: CGRect,
        side: CGFloat,
        in context: inout GraphicsContext
    ) {
        let highlight = Path(roundedRect: bodyRect, cornerRadius: 0)
        context.fill(
            highlight,
            with: .radialGradient(
                Gradient(colors: [
                    Color(hex: ShannonWaterlightVisualTokens.faceGlow)
                        .opacity(increasedContrast ? 0.44 : 0.34),
                    Color(hex: ShannonWaterlightVisualTokens.faceGlow).opacity(0),
                ]),
                center: CGPoint(
                    x: bodyRect.midX,
                    y: bodyRect.minY + bodyRect.height * 0.36
                ),
                startRadius: 0,
                endRadius: bodyRect.width * 0.64
            )
        )

        let lineSpacing = side * ShannonWaterlightVisualTokens.scanlineSpacingRatio
        let lineWidth = max(0.5, side * ShannonWaterlightVisualTokens.scanlineWidthRatio)
        var y = bodyRect.minY + lineSpacing
        while y < bodyRect.maxY {
            var line = Path()
            line.move(to: CGPoint(x: bodyRect.minX, y: y))
            line.addLine(to: CGPoint(x: bodyRect.maxX, y: y))
            context.stroke(
                line,
                with: .color(
                    Color(hex: ShannonWaterlightVisualTokens.scanline)
                        .opacity(increasedContrast ? 0.095 : 0.055)
                ),
                lineWidth: lineWidth
            )
            y += lineSpacing
        }

        let scale = side / 160
        var glassSheen = Path()
        glassSheen.move(to: CGPoint(x: 24 * scale, y: 45 * scale))
        glassSheen.addCurve(
            to: CGPoint(x: 139 * scale, y: 45 * scale),
            control1: CGPoint(x: 53 * scale, y: 23 * scale),
            control2: CGPoint(x: 102 * scale, y: 20 * scale)
        )
        context.stroke(
            glassSheen,
            with: .color(
                Color(hex: ShannonWaterlightVisualTokens.glassSheen)
                    .opacity(increasedContrast ? 0.09 : 0.055)
            ),
            style: StrokeStyle(lineWidth: 10 * scale, lineCap: .round)
        )
    }

    private func drawDecor(
        _ decor: ShannonEyeRig.Decor,
        center: CGPoint,
        radius: CGFloat,
        in context: inout GraphicsContext
    ) {
        guard decor.strength > 0 else { return }
        let water = Color(hex: ShannonWaterlightVisualTokens.eyeMiddle)
            .opacity(0.58 * decor.strength)
        switch decor.kind {
        case .none:
            break
        case .orbit:
            for index in 0..<3 {
                let inset = CGFloat(index) * radius * 0.055
                let rect = CGRect(
                    x: center.x - radius * 0.52 - inset,
                    y: center.y - radius * 0.25 - inset * 0.4,
                    width: radius * 1.04 + inset * 2,
                    height: radius * 0.50 + inset * 0.8
                )
                var path = Path()
                path.addEllipse(in: rect)
                context.stroke(
                    path,
                    with: .color(water.opacity(0.58 - Double(index) * 0.11)),
                    style: StrokeStyle(
                        lineWidth: max(0.8, radius / 82),
                        dash: [radius * 0.55, radius * 0.20],
                        dashPhase: CGFloat(decor.phase) * radius * 2.8 + CGFloat(index) * radius * 0.34
                    )
                )
            }
        case .thinkingDot:
            let beat = CGFloat(0.80 + 0.35 * max(0, sin((decor.phase - 0.18) * 2 * .pi)))
            let diameter = radius * 0.145 * ShannonEyeRig.heroEyeScale * beat
            let rect = CGRect(
                x: center.x - diameter / 2,
                y: center.y + radius * 0.015 - diameter / 2,
                width: diameter,
                height: diameter
            )
            context.fill(
                Path(ellipseIn: rect),
                with: .linearGradient(
                    Gradient(colors: ShannonWaterlightVisualTokens.eyeGradient),
                    startPoint: CGPoint(x: rect.minX, y: rect.minY),
                    endPoint: CGPoint(x: rect.maxX, y: rect.maxY)
                )
            )
        case .scan:
            let sweep = CGFloat(sin(decor.phase * 2 * .pi))
            let y = center.y - radius * 0.02 + CGFloat(cos(decor.phase * 2 * .pi)) * radius * 0.03
            var path = Path()
            path.move(to: CGPoint(x: center.x - radius * 0.58 + sweep * radius * 0.10, y: y))
            path.addCurve(
                to: CGPoint(x: center.x + radius * 0.58 + sweep * radius * 0.10, y: y),
                control1: CGPoint(x: center.x - radius * 0.22, y: y - radius * 0.05),
                control2: CGPoint(x: center.x + radius * 0.22, y: y + radius * 0.05)
            )
            context.stroke(path, with: .color(water.opacity(0.46)), lineWidth: max(1, radius / 62))
        case .burst:
            let angles: [CGFloat] = [-2.65, -1.98, -1.18, -0.42, 0.18, 0.76]
            for (index, angle) in angles.enumerated() {
                let strength = CGFloat(decor.strength)
                let distance = radius * (0.26 + strength * (0.29 + CGFloat(index) * 0.024))
                let dot = radius * (0.042 + strength * 0.035)
                let point = CGPoint(
                    x: center.x + cos(angle) * distance,
                    y: center.y + sin(angle) * distance
                )
                context.fill(
                    Path(ellipseIn: CGRect(x: point.x - dot, y: point.y - dot, width: dot * 2, height: dot * 2)),
                    with: .color(water.opacity(max(0, 1 - Double(index) * 0.065)))
                )
            }
        }
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
                x: center.x + (eye.position.x + eye.configuration.offsetX) * radius
                    + (eye.position.x < 0 ? -radius * 0.16 : radius * 0.16) - cheekWidth / 2,
                y: center.y + (eye.position.y + eye.configuration.offsetY) * radius + radius * 0.13,
                width: cheekWidth,
                height: cheekHeight
            )
            context.fill(
                Path(roundedRect: cheekRect, cornerRadius: cheekHeight / 2),
                with: .color(Color(hex: ShannonWaterlightVisualTokens.blush).opacity(blushOpacity))
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
            let eyeBounds = eyePath.boundingRect
            var eyeContext = context
            eyeContext.opacity = min(1, max(0, (eye.depth - 0.08) / 0.35))
            eyeContext.fill(
                eyePath,
                with: .linearGradient(
                    Gradient(colors: [
                        Color(hex: ShannonWaterlightVisualTokens.eyeTop),
                        Color(hex: ShannonWaterlightVisualTokens.eyeMiddle),
                        Color(hex: ShannonWaterlightVisualTokens.eyeBottom),
                    ]),
                    startPoint: CGPoint(
                        x: eyeBounds.minX + eyeBounds.width * 0.12,
                        y: eyeBounds.minY
                    ),
                    endPoint: CGPoint(
                        x: eyeBounds.minX + eyeBounds.width * 0.86,
                        y: eyeBounds.maxY
                    )
                )
            )

            guard eyeHeight > radius * 0.16 else { continue }
            var sheen = Path()
            sheen.move(to: CGPoint(x: -eyeWidth * 0.18, y: -eyeHeight * 0.27))
            sheen.addQuadCurve(
                to: CGPoint(x: eyeWidth * 0.18, y: -eyeHeight * 0.27),
                control: CGPoint(x: 0, y: -eyeHeight * 0.36)
            )
            sheen = sheen.applying(transform(for: eye, center: center, radius: radius, lid: frame.lid))
            eyeContext.stroke(
                sheen,
                with: .color(Color(hex: ShannonWaterlightVisualTokens.eyeSheen).opacity(0.48)),
                lineWidth: max(0.7, radius * 1.8 / 68)
            )
        }
    }

    private func transform(
        for eye: ShannonEyeRig.ProjectedEye,
        center: CGPoint,
        radius: CGFloat,
        lid: Double
    ) -> CGAffineTransform {
        let blinkScale = eye.configuration.open * ShannonEyeRig.blinkScale(lid)
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
            tx: center.x + (eye.position.x + eye.configuration.offsetX) * radius,
            ty: center.y + (eye.position.y + eye.configuration.offsetY) * radius
        )
    }
}
