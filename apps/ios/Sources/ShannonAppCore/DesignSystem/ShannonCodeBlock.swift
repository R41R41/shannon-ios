// Adapted from Swift Pieces "Code Block" (registry/swift/ai/CodeBlock.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Rewritten for Shannon: semantic palette, appearance-following reading surface,
// Japanese labels, and a platform pasteboard adapter so the shared package builds on iOS and macOS.

import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Collapse rules shared by the iPhone and Mac code blocks.
public enum ShannonCodeBlockLayout {
    public static let defaultCollapseAfter = 12

    /// A block only collapses when it would hide more than two lines, so the
    /// "show more" control never reveals a trivially short remainder.
    public static func isCollapsible(lineCount: Int, collapseAfter: Int = defaultCollapseAfter) -> Bool {
        lineCount > collapseAfter + 2
    }

    public static func visibleLineCount(lineCount: Int, collapseAfter: Int = defaultCollapseAfter, isExpanded: Bool) -> Int {
        guard isCollapsible(lineCount: lineCount, collapseAfter: collapseAfter), !isExpanded else { return lineCount }
        return collapseAfter
    }

    public static func hiddenLineCount(lineCount: Int, collapseAfter: Int = defaultCollapseAfter, isExpanded: Bool) -> Int {
        lineCount - visibleLineCount(lineCount: lineCount, collapseAfter: collapseAfter, isExpanded: isExpanded)
    }

    public static func accessibilityLabel(language: String?, lineCount: Int) -> String {
        let name = ShannonCodeSyntax.displayName(for: language).map { "\($0)の" } ?? ""
        return "\(name)コード、\(lineCount)行"
    }
}

enum ShannonPasteboard {
    static func copy(_ text: String) {
#if canImport(UIKit)
        UIPasteboard.general.string = text
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#endif
    }
}

/// Fenced code inside a Shannon reply: language label, copy, collapse, selection and horizontal scroll.
struct ShannonCodeBlock: View {
    let code: String
    let language: String?
    let palette: ShannonPalette
    var collapseAfter = ShannonCodeBlockLayout.defaultCollapseAfter

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded = false
    @State private var didCopy = false
    @State private var copyCount = 0

    private var lines: [AttributedString] {
        ShannonCodeSyntax.tokenize(code, language: language).map { tokens in
            ShannonCodeSyntax.attributedLine(tokens, color: Color.shannonCodeSyntax)
        }
    }

    var body: some View {
        let lines = lines
        let visible = ShannonCodeBlockLayout.visibleLineCount(
            lineCount: lines.count, collapseAfter: collapseAfter, isExpanded: isExpanded
        )
        let hidden = lines.count - visible
        let collapsible = ShannonCodeBlockLayout.isCollapsible(lineCount: lines.count, collapseAfter: collapseAfter)

        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView(.horizontal) {
                // One Text keeps selection continuous across lines.
                Text(Self.joined(lines.prefix(visible)))
                .fixedSize(horizontal: true, vertical: false)
                .font(.system(.callout, design: .monospaced))
                .lineSpacing(3)
                .foregroundStyle(palette.textPrimary)
                .textSelection(.enabled)
                .padding(.horizontal, ShannonSpacing.medium)
                .padding(.bottom, collapsible ? ShannonSpacing.extraSmall : ShannonSpacing.medium)
            }
            .scrollIndicators(.hidden)
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: hidden > 0 ? 0.62 : 1),
                        .init(color: hidden > 0 ? .clear : .black, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }

            if collapsible {
                Button {
                    withAnimation(expandAnimation) { isExpanded.toggle() }
                } label: {
                    Label(
                        hidden > 0 ? "残り\(hidden)行を表示" : "折りたたむ",
                        systemImage: hidden > 0 ? "chevron.down" : "chevron.up"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.action)
                    .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(hidden > 0 ? "コードの続きを表示します" : "最初の\(collapseAfter)行だけにします")
            }
        }
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
        .sensoryFeedback(.success, trigger: copyCount)
        .task(id: copyCount) {
            guard copyCount > 0 else { return }
            try? await Task.sleep(for: .seconds(1.6))
            didCopy = false
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ShannonCodeBlockLayout.accessibilityLabel(language: language, lineCount: lines.count))
    }

    private var header: some View {
        HStack(spacing: ShannonSpacing.small) {
            Text(ShannonCodeSyntax.displayName(for: language) ?? "コード")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.textSecondary)
                .lineLimit(1)
            Spacer(minLength: ShannonSpacing.small)
            Button(action: copy) {
                Label(didCopy ? "コピー済み" : "コピー", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                    .font(.caption.weight(.semibold))
                    .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                    .foregroundStyle(didCopy ? palette.onSuccessTint : palette.textSecondary)
                    .padding(.horizontal, ShannonSpacing.medium)
                    .frame(minHeight: 30)
                    .background(didCopy ? palette.successTint : palette.elevatedSurface, in: Capsule())
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: didCopy)
            .accessibilityLabel(didCopy ? "コピー済み" : "コードをコピー")
        }
        .padding(.leading, ShannonSpacing.medium)
        .padding(.trailing, ShannonSpacing.extraSmall)
    }

    static func joined(_ lines: ArraySlice<AttributedString>) -> AttributedString {
        var result = AttributedString()
        for (offset, line) in lines.enumerated() {
            if offset > 0 { result.append(AttributedString("\n")) }
            result.append(line)
        }
        return result
    }

    private var expandAnimation: Animation? {
        reduceMotion ? .easeOut(duration: 0.15) : .spring(duration: 0.35, bounce: 0)
    }

    private func copy() {
        ShannonPasteboard.copy(code)
        didCopy = true
        copyCount += 1
    }
}
