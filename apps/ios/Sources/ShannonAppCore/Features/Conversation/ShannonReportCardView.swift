import SwiftUI

/// The report card under the short answer of finished work the owner asked for (rich chat, option A of 2026-10-13): the
/// report's first blocks (a table, a chart), the places on a map, how many sources, and 「開く」 for the whole report.
public struct ShannonReportCardView: View {
    let card: ShannonReportCardDTO
    @Environment(\.colorScheme) private var colorScheme
    @State private var isOpen = false

    /// Blocks shown on the card itself; the rest is in the opened report.
    static let previewBlocks = 4

    public init(card: ShannonReportCardDTO) {
        self.card = card
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let blocks = ShannonMessageMarkdown.blocks(from: card.report)
        let renderer = ShannonRichMarkdownText(source: "", palette: palette)
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                Label(card.title, systemImage: card.failed ? "exclamationmark.triangle" : "doc.text.magnifyingglass")
                    .font(.shannon(.subheadline).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if let date = card.reportedDate {
                    Text(date.formatted(date: .omitted, time: .shortened))
                        .font(.shannon(.caption2))
                        .foregroundStyle(palette.textSecondary)
                }
            }
            ForEach(Array(blocks.prefix(Self.previewBlocks).enumerated()), id: \.offset) { _, block in
                renderer.blockView(block)
            }
            if let places = card.places, !places.isEmpty {
                ShannonPlaceMapCard(places: places)
            }
            HStack(spacing: ShannonSpacing.small) {
                if !card.sources.isEmpty {
                    Text(sourceSummary)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.action)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Button {
                    isOpen = true
                } label: {
                    Text("開く")
                        .font(.shannon(.caption).weight(.semibold))
                        .padding(.horizontal, ShannonSpacing.medium)
                        .frame(minHeight: 32)
                        .overlay { Capsule().stroke(palette.divider, lineWidth: 1) }
                }
                .buttonStyle(.plain)
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityHint("報告の全文、出典、場所を開きます")
            }
        }
        .padding(ShannonSpacing.medium)
        .frame(maxWidth: 560, alignment: .leading)
        .background(palette.readingSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                .stroke(palette.divider, lineWidth: 0.8)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("調べた結果: \(card.title)")
        .shannonCoversFigure(isOpen)
        .sheet(isPresented: $isOpen) {
            ShannonReportDetailView(card: card)
        }
    }

    private var sourceSummary: String {
        let names = card.sources.prefix(2).map(\.title).joined(separator: " / ")
        return "出典 \(card.sources.count)件 ・ \(names)"
    }
}

/// The whole report: the short answer, the report with its tables, charts and images, what was found with its sources, and
/// the places.
struct ShannonReportDetailView: View {
    let card: ShannonReportCardDTO
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                    Text(card.answer)
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)
                        .textSelection(.enabled)
                    ShannonRichMarkdownText(source: card.report, palette: palette)
                        .textSelection(.enabled)
                        .tint(palette.action)
                    if !card.findings.isEmpty {
                        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                            Text("見つけたこと")
                                .font(.shannon(.headline))
                                .foregroundStyle(palette.textPrimary)
                            ForEach(Array(card.findings.enumerated()), id: \.offset) { _, finding in
                                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                                    Text(finding.text)
                                        .font(.shannon(.callout))
                                        .foregroundStyle(palette.textPrimary)
                                        .textSelection(.enabled)
                                    ForEach(Array(finding.sources.enumerated()), id: \.offset) { _, source in
                                        if let url = source.webURL {
                                            Link(destination: url) {
                                                Label(source.title, systemImage: "link")
                                                    .font(.shannon(.footnote))
                                            }
                                            .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let places = card.places, !places.isEmpty {
                        ShannonPlaceMapCard(places: places)
                    }
                }
                .padding(ShannonSpacing.large)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(palette.canvas)
            .navigationTitle(card.title)
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
#if os(macOS)
        .frame(minWidth: 560, minHeight: 600)
#endif
    }
}

/// What a message carries below it in the Talk (rich chat): its report card and the owner's reactions. Hidden while others
/// may see the screen. Shared by the iPhone and the Mac.
public struct ShannonMessageExtras: View {
    let message: ConversationMessage
    let conversation: ShannonConversationModel

    public init(message: ConversationMessage, conversation: ShannonConversationModel) {
        self.message = message
        self.conversation = conversation
    }

    public var body: some View {
        let reactions = conversation.reactions
        let card = reactions.othersPresent ? nil : message.reportCard
        let chips = !reactions.emojis(for: message).isEmpty && reactions.target(for: message, threadID: conversation.selectedThreadId) != nil
        let notice = reactions.noticeMessageID == message.id ? reactions.notice : nil
        // Nothing at all when there is nothing to show, so the Talk list adds no spacing under the message.
        if card != nil || chips || notice != nil {
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                if let card {
                    ShannonReportCardView(card: card)
                }
                if chips {
                    ShannonReactionChips(message: message, model: reactions, threadID: conversation.selectedThreadId)
                }
                if let notice {
                    Text(notice)
                        .font(.shannon(.caption))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
