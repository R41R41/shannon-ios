import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonRichMarkdownText: View {
    let source: String
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            ForEach(Array(ShannonMessageMarkdown.blocks(from: source).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .foregroundStyle(palette.textPrimary)
    }

    @ViewBuilder
    func blockView(_ block: ShannonMessageMarkdown.Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(ShannonMessageMarkdown.render(text))
                .font(headingFont(level))
                .padding(.top, level <= 2 ? ShannonSpacing.extraSmall : 0)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                Text("•")
                    .font(.shannon(.body).weight(.semibold))
                    .foregroundStyle(palette.brandPresence)
                Text(ShannonMessageMarkdown.render(text))
                    .font(.shannon(.body))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .numbered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                Text(marker)
                    .font(.shannon(.body).monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
                Text(ShannonMessageMarkdown.render(text))
                    .font(.shannon(.body))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .quote(let text):
            HStack(alignment: .top, spacing: ShannonSpacing.medium) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(palette.brandPresence)
                    .frame(width: 3)
                Text(ShannonMessageMarkdown.render(text))
                    .font(.shannon(.body))
                    .foregroundStyle(palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 2)

        case .code(let text, let language):
            ShannonCodeBlock(code: text, language: language, palette: palette)

        case .divider:
            Divider()
                .overlay(palette.divider)

        case .paragraph(let text):
            Text(ShannonMessageMarkdown.render(text))
                .font(.shannon(.body))
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .table, .image, .chart:
            ShannonRichBlockView(block: block)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .shannon(.title2).weight(.bold)
        case 2: .shannon(.title3).weight(.bold)
        default: .shannon(.headline)
        }
    }
}

struct ShannonDialogueBubble<Content: View>: View {
    let palette: ShannonPalette
    let isExpanded: Bool
    var maxWidth: CGFloat = 350
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.vertical, ShannonSpacing.medium)
            .frame(maxWidth: maxWidth, minHeight: 54, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(palette.divider.opacity(0.62), lineWidth: 0.7)
            }
            .overlay(alignment: .bottom) {
                ShannonSpeechTail()
                    .fill(palette.canvas.opacity(0.94))
                    .frame(width: 24, height: 16)
                    .offset(x: 74, y: 14)
            }
            .shadow(color: .black.opacity(0.11), radius: isExpanded ? 18 : 12, y: 5)
            .padding(.horizontal, ShannonSpacing.large)
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
