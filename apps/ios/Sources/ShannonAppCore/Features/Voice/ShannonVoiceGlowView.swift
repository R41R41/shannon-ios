import SwiftUI

/// Decorative voice presence for the live call surface. Operational meaning
/// remains in the visible status label and Waterlight Eye state.
///
/// The layered edge light and audio envelope are a native SwiftUI adaptation
/// of the MIT-licensed `voice-glow` interaction: https://libraries.dev/voice
struct ShannonVoiceGlowView: View {
    let phase: ShannonRealtimeVoicePhase
    let microphoneLevel: Double
    let playbackLevel: Double
    let isMuted: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Group {
            if reduceMotion {
                glowCanvas(at: 0, palette: palette, isAnimated: false)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    glowCanvas(
                        at: timeline.date.timeIntervalSinceReferenceDate,
                        palette: palette,
                        isAnimated: true
                    )
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func glowCanvas(
        at elapsedTime: TimeInterval,
        palette: ShannonPalette,
        isAnimated: Bool
    ) -> some View {
        let sample = ShannonVoiceGlowDynamics.sample(
            phase: phase,
            microphoneLevel: microphoneLevel,
            playbackLevel: playbackLevel,
            isMuted: isMuted,
            elapsedTime: elapsedTime,
            reduceMotion: !isAnimated
        )
        let colors = [
            palette.intelligenceDepth,
            palette.brandPresence,
            palette.intelligenceSky,
            palette.brandPresence,
            palette.intelligenceDepth,
        ]

        return Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, size in
            guard size.width > 0, size.height > 0 else { return }
            let increasedContrast = colorSchemeContrast == .increased
            let transparencyScale = reduceTransparency ? 0.68 : 1.0
            let baseOpacity = sample.opacity * transparencyScale

            var bloom = context
            bloom.opacity = baseOpacity * (increasedContrast ? 0.82 : 0.66)
            bloom.addFilter(.blur(radius: reduceTransparency ? 12 : 24))
            drawLobes(
                in: &bloom,
                size: size,
                sample: sample,
                colors: colors,
                verticalScale: 1.16
            )

            var inner = context
            inner.opacity = baseOpacity * (increasedContrast ? 0.94 : 0.78)
            inner.addFilter(.blur(radius: reduceTransparency ? 5 : 10))
            drawLobes(
                in: &inner,
                size: size,
                sample: sample,
                colors: colors,
                verticalScale: 0.82
            )

            drawBand(
                in: &context,
                size: size,
                sample: sample,
                colors: colors,
                opacity: baseOpacity * (increasedContrast ? 1 : 0.86)
            )
        }
    }

    private func drawLobes(
        in context: inout GraphicsContext,
        size: CGSize,
        sample: ShannonVoiceGlowSample,
        colors: [Color],
        verticalScale: CGFloat
    ) {
        let bottom = size.height + 8
        let baseWidth = size.width * (sample.isProcessing ? 0.18 : 0.34)
        let spread = size.width * (sample.isProcessing ? 0.035 : 0.13 + sample.level * 0.05)
        let height = size.height * (0.18 + sample.level * 0.72) * verticalScale
        let center = size.width * (0.5 + sample.processingPosition * 0.34)

        for index in colors.indices {
            let offset = CGFloat(index - colors.count / 2)
            let flow = sample.isProcessing
                ? 0
                : sin(sample.flowPhase + Double(index) * 1.17) * size.width * 0.018 * sample.level
            let widthScale = index == colors.count / 2 ? 1.08 : 0.88
            let rect = CGRect(
                x: center + offset * spread + flow - baseWidth * widthScale / 2,
                y: bottom - height,
                width: baseWidth * widthScale,
                height: height * 1.42
            )
            context.fill(
                Path(ellipseIn: rect),
                with: .radialGradient(
                    Gradient(colors: [
                        colors[index].opacity(index == colors.count / 2 ? 0.96 : 0.78),
                        colors[index].opacity(0.32),
                        colors[index].opacity(0),
                    ]),
                    center: CGPoint(x: rect.midX, y: rect.maxY - rect.height * 0.26),
                    startRadius: 0,
                    endRadius: max(rect.width, rect.height) * 0.58
                )
            )
        }
    }

    private func drawBand(
        in context: inout GraphicsContext,
        size: CGSize,
        sample: ShannonVoiceGlowSample,
        colors: [Color],
        opacity: Double
    ) {
        let center = size.width * (0.5 + sample.processingPosition * 0.34)
        let halfRange = size.width * (sample.isProcessing ? 0.12 : 0.52)
        let peak = size.height * (0.08 + sample.level * 0.50)
        let baseline = size.height - 5
        let steps = 72
        var path = Path()

        for step in 0...steps {
            let progress = CGFloat(step) / CGFloat(steps)
            let x = center - halfRange + progress * halfRange * 2
            let normalized = abs((x - center) / max(1, halfRange))
            let bell = exp(-pow(Double(normalized / 0.72), 1.75))
            let y = baseline - peak * bell
            if step == 0 { path.move(to: CGPoint(x: x, y: y)) }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }

        var softBand = context
        softBand.opacity = opacity * 0.52
        softBand.addFilter(.blur(radius: 5))
        softBand.stroke(
            path,
            with: .linearGradient(
                Gradient(colors: colors),
                startPoint: CGPoint(x: center - halfRange, y: baseline),
                endPoint: CGPoint(x: center + halfRange, y: baseline)
            ),
            style: StrokeStyle(lineWidth: 7 + sample.level * 5, lineCap: .round, lineJoin: .round)
        )

        context.opacity = opacity
        context.stroke(
            path,
            with: .linearGradient(
                Gradient(colors: [
                    colors[0].opacity(0.15),
                    colors[1],
                    Color.white.opacity(0.94),
                    colors[3],
                    colors[4].opacity(0.15),
                ]),
                startPoint: CGPoint(x: center - halfRange, y: baseline),
                endPoint: CGPoint(x: center + halfRange, y: baseline)
            ),
            style: StrokeStyle(lineWidth: 1.2 + sample.level * 1.8, lineCap: .round, lineJoin: .round)
        )
    }
}

struct ShannonVoiceGlowSample: Equatable, Sendable {
    let level: Double
    let opacity: Double
    let processingPosition: Double
    let flowPhase: Double
    let isProcessing: Bool
}

enum ShannonVoiceGlowDynamics {
    static func sample(
        phase: ShannonRealtimeVoicePhase,
        microphoneLevel: Double,
        playbackLevel: Double,
        isMuted: Bool,
        elapsedTime: TimeInterval,
        reduceMotion: Bool
    ) -> ShannonVoiceGlowSample {
        let microphone = isMuted ? 0 : clamped(microphoneLevel)
        let playback = clamped(playbackLevel)
        let isProcessing = phase == .thinking
        let level: Double
        let opacity: Double

        switch phase {
        case .listening:
            level = max(0.10, microphone)
            opacity = 0.92
        case .speaking:
            level = max(0.18, playback)
            opacity = 1
        case .thinking:
            level = 0.38
            opacity = 0.94
        case .connecting, .requestingPermission:
            level = 0.13
            opacity = 0.68
        case .idle:
            level = 0.07
            opacity = 0.42
        case .failed:
            level = 0.04
            opacity = 0.24
        }

        let processingPosition = if isProcessing && !reduceMotion {
            sin(elapsedTime * .pi / 1.05)
        } else {
            0.0
        }
        let flowPhase = reduceMotion ? 0 : elapsedTime * (0.7 + level * 1.8)
        return ShannonVoiceGlowSample(
            level: level,
            opacity: opacity,
            processingPosition: processingPosition,
            flowPhase: flowPhase,
            isProcessing: isProcessing
        )
    }

    private static func clamped(_ value: Double) -> Double {
        min(1, max(0, value.isFinite ? value : 0))
    }
}
