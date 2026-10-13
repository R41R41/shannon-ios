import SwiftUI

/// Her reply while it is written, sentence by sentence (docs/chat-stream-contract.md), drawn like her message
/// without what only `done` brings: no face name, copy, reactions, cards or captures yet. When the stream broke,
/// what arrived stays with a line that says so; 再送 is on his message and in the snackbar.
struct ShannonStreamingReplyRow: View {
    let reply: ShannonStreamingReply
    let face: ShannonFace

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            HStack(alignment: .center, spacing: ShannonSpacing.extraSmall) {
                ShannonMessageAvatarView(face: face, size: 30)
                Text("シャノン")
                    .font(.shannon(.callout).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                Text("· \(reply.phase == .writing ? "書いています…" : "途中で途切れました")")
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .font(.shannon(.caption2))
            .foregroundStyle(reply.phase == .interrupted ? palette.danger : palette.textSecondary)

            ShannonRichMarkdownText(source: reply.text, palette: palette)
                .textSelection(.enabled)
                .tint(palette.action)
                .frame(maxWidth: .infinity, alignment: .leading)
                .opacity(reply.phase == .interrupted ? 0.72 : 1)

            if reply.phase == .interrupted {
                Label("返事はここで途切れています", systemImage: "exclamationmark.circle")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.danger)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(reply.phase == .writing
            ? "シャノン、書いています。\(reply.text)"
            : "シャノン、途中で途切れた返事。\(reply.text)")
    }
}

/// The dialogue display's bubble while her reply is written: as tall as the words while they fit, and past the
/// usual limit the newest words stay in view. `done` brings the ordinary bubble with 「続きを読む」 and コピー.
struct ShannonDialogueStreamingBubble: View {
    let text: String
    let palette: ShannonPalette
    let maxWidth: CGFloat

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ShannonDialogueBubble(palette: palette, isExpanded: false, maxWidth: maxWidth) {
            ViewThatFits(in: .vertical) {
                words
                ScrollView(.vertical) { words }
                    .defaultScrollAnchor(.bottom)
                    .scrollIndicators(.hidden)
            }
            .frame(maxHeight: dynamicTypeSize.isAccessibilitySize ? 180 : 156)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("シャノン、書いています。\(text)")
    }

    private var words: some View {
        ShannonRichMarkdownText(source: text, palette: palette)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
