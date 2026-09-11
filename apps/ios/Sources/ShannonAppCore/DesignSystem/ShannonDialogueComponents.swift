import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonRichMarkdownText: View {
    let source: String
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            ForEach(Array(ShannonMessageMarkdown.blocks(from: source).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .foregroundStyle(palette.onSurface)
    }

    @ViewBuilder
    func blockView(_ block: ShannonMessageMarkdown.Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(ShannonMessageMarkdown.render(text))
                .font(headingFont(level))
                .padding(.top, level <= 2 ? M3Spacing.extraSmall : 0)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: M3Spacing.small) {
                Text("•")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.brandPresence)
                Text(ShannonMessageMarkdown.render(text))
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .numbered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: M3Spacing.small) {
                Text(marker)
                    .font(.body.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
                Text(ShannonMessageMarkdown.render(text))
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .quote(let text):
            HStack(alignment: .top, spacing: M3Spacing.medium) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(palette.brandPresence)
                    .frame(width: 3)
                Text(ShannonMessageMarkdown.render(text))
                    .font(.body)
                    .foregroundStyle(palette.onSurfaceVariant)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 2)

        case .code(let text):
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(palette.onSurface)
                    .padding(M3Spacing.medium)
                    .textSelection(.enabled)
            }
            .scrollIndicators(.hidden)
            .background(
                palette.surfaceContainer,
                in: RoundedRectangle(cornerRadius: M3Shape.medium, style: .continuous)
            )

        case .divider:
            Divider()
                .overlay(palette.outlineVariant)

        case .paragraph(let text):
            Text(ShannonMessageMarkdown.render(text))
                .font(.body)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.bold)
        case 2: .title3.weight(.bold)
        default: .headline
        }
    }
}

struct ShannonTypingIndicator: View {
    let expression: ShannonExpressionDTO

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            ShannonAvatarView(expression: expression, size: 54)
            HStack(spacing: M3Spacing.small) {
                ProgressView()
                    .controlSize(.small)
                    .tint(palette.primary)
                Text("考えている…")
                    .font(.callout)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            .padding(.horizontal, M3Spacing.large)
            .frame(minHeight: M3TouchTarget.minimum)
            .background(palette.surfaceContainerHigh, in: Capsule())
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("シャノンが考えています")
    }
}

struct ShannonDialogueBubble<Content: View>: View {
    let palette: M3Palette
    let isExpanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, M3Spacing.large)
            .padding(.vertical, M3Spacing.medium)
            .frame(maxWidth: 350, minHeight: 54, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(palette.outlineVariant.opacity(0.62), lineWidth: 0.7)
            }
            .overlay(alignment: .bottom) {
                ShannonSpeechTail()
                    .fill(palette.surface.opacity(0.94))
                    .frame(width: 24, height: 16)
                    .offset(x: 74, y: 14)
            }
            .shadow(color: .black.opacity(0.11), radius: isExpanded ? 18 : 12, y: 5)
            .padding(.horizontal, M3Spacing.large)
            .accessibilityElement(children: .contain)
    }
}

struct ShannonSpeechTail: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addQuadCurve(
            to: CGPoint(x: rect.width, y: 0),
            control: CGPoint(x: rect.width * 0.58, y: rect.height * 0.18)
        )
        path.addLine(to: CGPoint(x: rect.width * 0.70, y: rect.height))
        path.closeSubpath()
        return path
    }
}

struct ShannonThinkingDots: View {
    @State var activeDot = 0
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var body: some View {
        HStack(spacing: 7) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .frame(width: 7, height: 7)
                    .scaleEffect(!reduceMotion && activeDot == index ? 1.35 : 0.82)
                    .opacity(reduceMotion || activeDot == index ? 1 : 0.42)
            }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, minHeight: 24, alignment: .center)
        .accessibilityLabel("シャノンが考えています")
        .task {
            guard !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(380))
                withAnimation(.easeInOut(duration: 0.22)) {
                    activeDot = (activeDot + 1) % 3
                }
            }
        }
    }
}

func threadUpdatedLabel(_ value: String) -> String {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    let date = (try? fractional.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    guard let date else { return "更新日時不明" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) {
        return date.formatted(date: .omitted, time: .shortened)
    }
    if calendar.isDateInYesterday(date) { return "昨日" }
    return date.formatted(.dateTime.month(.abbreviated).day())
}
