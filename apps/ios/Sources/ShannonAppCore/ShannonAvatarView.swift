import SwiftUI

public struct ShannonAvatarView: View {
    public let expression: ShannonExpressionDTO
    public let size: CGFloat

    @Environment(\.colorScheme) private var colorScheme

    public init(expression: ShannonExpressionDTO, size: CGFloat = 44) {
        self.expression = expression
        self.size = size
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        ZStack {
            Circle()
                .fill(backgroundColor(palette))

            Circle()
                .fill(palette.secondary.opacity(colorScheme == .dark ? 0.92 : 0.82))
                .frame(width: size * 0.72, height: size * 0.76)
                .offset(y: size * 0.07)

            Ellipse()
                .fill(Color(hex: colorScheme == .dark ? 0xF2D0BE : 0xFFE0CF))
                .frame(width: size * 0.54, height: size * 0.58)
                .offset(y: size * 0.08)

            maidHeadband(palette)

            ShannonFaceCanvas(expression: expression)
                .frame(width: size * 0.47, height: size * 0.36)
                .offset(y: size * 0.10)
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(palette.outlineVariant.opacity(0.7), lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(expression.accessibilityDescription)
    }

    private func backgroundColor(_ palette: M3Palette) -> Color {
        switch expression {
        case .joyful: palette.tertiaryContainer
        case .curious: palette.primaryContainer
        case .tender: palette.tertiaryContainer
        case .concerned, .sad: palette.secondaryContainer
        case .sleepy: palette.surfaceContainerHigh
        case .calm, .neutral: palette.primaryContainer
        }
    }

    private func maidHeadband(_ palette: M3Palette) -> some View {
        ZStack {
            Capsule()
                .fill(palette.surface)
                .frame(width: size * 0.49, height: size * 0.13)
            HStack(spacing: size * 0.035) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle()
                        .fill(palette.surface)
                        .frame(width: size * 0.13, height: size * 0.13)
                }
            }
            .offset(y: size * 0.045)
        }
        .offset(y: -size * 0.23)
    }
}

private struct ShannonFaceCanvas: View {
    let expression: ShannonExpressionDTO

    var body: some View {
        Canvas { context, size in
            let ink = Color(hex: 0x3B2730)
            let stroke = StrokeStyle(lineWidth: max(1.35, size.width * 0.055), lineCap: .round, lineJoin: .round)
            let leftX = size.width * 0.28
            let rightX = size.width * 0.72
            let eyeY = size.height * 0.38

            if expression == .joyful {
                context.stroke(eyeSmile(x: leftX, y: eyeY, scale: size.width), with: .color(ink), style: stroke)
                context.stroke(eyeSmile(x: rightX, y: eyeY, scale: size.width), with: .color(ink), style: stroke)
            } else if expression == .sleepy || expression == .calm {
                context.stroke(closedEye(x: leftX, y: eyeY, scale: size.width), with: .color(ink), style: stroke)
                context.stroke(closedEye(x: rightX, y: eyeY, scale: size.width), with: .color(ink), style: stroke)
            } else {
                let leftRadius = expression == .curious ? size.width * 0.044 : size.width * 0.036
                let rightRadius = expression == .curious ? size.width * 0.032 : size.width * 0.036
                context.fill(Path(ellipseIn: CGRect(x: leftX - leftRadius, y: eyeY - leftRadius, width: leftRadius * 2, height: leftRadius * 2)), with: .color(ink))
                context.fill(Path(ellipseIn: CGRect(x: rightX - rightRadius, y: eyeY - rightRadius, width: rightRadius * 2, height: rightRadius * 2)), with: .color(ink))
            }

            if expression == .concerned || expression == .sad || expression == .curious {
                context.stroke(leftBrow(size: size), with: .color(ink), style: stroke)
                context.stroke(rightBrow(size: size), with: .color(ink), style: stroke)
            }

            context.stroke(mouth(size: size), with: .color(ink), style: stroke)

            if expression == .joyful || expression == .tender {
                let blush = Color(hex: 0xE89A9A, alpha: 0.48)
                let blushSize = size.width * 0.13
                context.fill(Path(ellipseIn: CGRect(x: size.width * 0.10, y: size.height * 0.58, width: blushSize, height: blushSize * 0.45)), with: .color(blush))
                context.fill(Path(ellipseIn: CGRect(x: size.width * 0.77, y: size.height * 0.58, width: blushSize, height: blushSize * 0.45)), with: .color(blush))
            }
        }
    }

    private func closedEye(x: CGFloat, y: CGFloat, scale: CGFloat) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: x - scale * 0.065, y: y))
        path.addQuadCurve(to: CGPoint(x: x + scale * 0.065, y: y), control: CGPoint(x: x, y: y + scale * 0.055))
        return path
    }

    private func eyeSmile(x: CGFloat, y: CGFloat, scale: CGFloat) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: x - scale * 0.065, y: y + scale * 0.025))
        path.addQuadCurve(to: CGPoint(x: x + scale * 0.065, y: y + scale * 0.025), control: CGPoint(x: x, y: y - scale * 0.055))
        return path
    }

    private func leftBrow(size: CGSize) -> Path {
        var path = Path()
        let raised = expression == .curious
        path.move(to: CGPoint(x: size.width * 0.19, y: size.height * (raised ? 0.17 : 0.22)))
        path.addLine(to: CGPoint(x: size.width * 0.36, y: size.height * (raised ? 0.11 : 0.27)))
        return path
    }

    private func rightBrow(size: CGSize) -> Path {
        var path = Path()
        let raised = expression == .curious
        path.move(to: CGPoint(x: size.width * 0.64, y: size.height * (raised ? 0.25 : 0.27)))
        path.addLine(to: CGPoint(x: size.width * 0.81, y: size.height * (raised ? 0.18 : 0.22)))
        return path
    }

    private func mouth(size: CGSize) -> Path {
        var path = Path()
        let start = CGPoint(x: size.width * 0.39, y: size.height * 0.70)
        let end = CGPoint(x: size.width * 0.61, y: size.height * 0.70)
        path.move(to: start)

        switch expression {
        case .joyful:
            path.addQuadCurve(to: end, control: CGPoint(x: size.width * 0.50, y: size.height * 0.88))
        case .tender, .calm:
            path.addQuadCurve(to: end, control: CGPoint(x: size.width * 0.50, y: size.height * 0.79))
        case .concerned, .sad:
            path.addQuadCurve(to: end, control: CGPoint(x: size.width * 0.50, y: size.height * 0.60))
        case .sleepy:
            path.addQuadCurve(to: end, control: CGPoint(x: size.width * 0.50, y: size.height * 0.73))
        case .curious:
            path.addQuadCurve(to: end, control: CGPoint(x: size.width * 0.50, y: size.height * 0.80))
        case .neutral:
            path.addLine(to: end)
        }
        return path
    }
}

