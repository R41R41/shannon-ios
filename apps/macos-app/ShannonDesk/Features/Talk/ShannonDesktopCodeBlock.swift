// Adapted from Swift Pieces "Code Block" (registry/swift/ai/CodeBlock.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Mac expression of Shannon's reply code block: pointer-sized controls, NSPasteboard,
// and the shared ShannonAppCore syntax roles and collapse rules.

import AppKit
import ShannonAppCore
import SwiftUI

struct DesktopCodeBlockView: View {
    let code: String
    let language: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded = false
    @State private var didCopy = false
    @State private var copyCount = 0

    var body: some View {
        let lines = ShannonCodeSyntax.tokenize(code, language: language).map { tokens in
            ShannonCodeSyntax.attributedLine(tokens, color: Color.shannonCodeSyntax)
        }
        let visible = ShannonCodeBlockLayout.visibleLineCount(lineCount: lines.count, isExpanded: isExpanded)
        let hidden = lines.count - visible
        let collapsible = ShannonCodeBlockLayout.isCollapsible(lineCount: lines.count)

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: ShannonDesktopSpacing.small) {
                Text(ShannonCodeSyntax.displayName(for: language) ?? "コード")
                    .font(.shannonDesktop(.caption).weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button(action: copy) {
                    Label(didCopy ? "コピー済み" : "コピー", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.shannonDesktop(.caption).weight(.semibold))
                        .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                        .foregroundStyle(didCopy ? Color.shannonSuccess : Color.secondary)
                }
                .buttonStyle(.borderless)
                .help("コードをクリップボードへコピー")
                .accessibilityLabel(didCopy ? "コピー済み" : "コードをコピー")
            }
            .padding(.horizontal, ShannonDesktopSpacing.medium)
            .padding(.top, ShannonDesktopSpacing.small)
            .padding(.bottom, ShannonDesktopSpacing.extraSmall)

            ScrollView(.horizontal) {
                Text(joined(lines.prefix(visible)))
                    .font(.shannonDesktop(.body).monospaced())
                    .fixedSize(horizontal: true, vertical: false)
                    .textSelection(.enabled)
                    .padding(.horizontal, ShannonDesktopSpacing.medium)
                    .padding(.bottom, collapsible ? 4 : 12)
            }
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
                    withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(duration: 0.35, bounce: 0)) {
                        isExpanded.toggle()
                    }
                } label: {
                    Label(
                        hidden > 0 ? "残り\(hidden)行を表示" : "折りたたむ",
                        systemImage: hidden > 0 ? "chevron.down" : "chevron.up"
                    )
                    .font(.shannonDesktop(.caption).weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .padding(.bottom, 6)
            }
        }
        .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium))
        .overlay { RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium).stroke(Color.primary.opacity(0.08), lineWidth: 0.5) }
        .task(id: copyCount) {
            guard copyCount > 0 else { return }
            try? await Task.sleep(for: .seconds(1.6))
            didCopy = false
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ShannonCodeBlockLayout.accessibilityLabel(language: language, lineCount: lines.count))
    }

    private func joined(_ lines: ArraySlice<AttributedString>) -> AttributedString {
        var result = AttributedString()
        for (offset, line) in lines.enumerated() {
            if offset > 0 { result.append(AttributedString("\n")) }
            result.append(line)
        }
        return result
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        didCopy = true
        copyCount += 1
    }
}
