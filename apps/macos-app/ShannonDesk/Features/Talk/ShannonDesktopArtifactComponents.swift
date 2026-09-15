import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopConversationOutlineView: View {
    let summary: String?
    let entries: [ShannonDesktopConversationOutlineEntry]
    let activeEntryID: String?
    let close: () -> Void
    let select: (ShannonDesktopConversationOutlineEntry) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var visibleSummary: String? {
        guard let summary else { return nil }
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("会話の目次")
                        .font(.headline)
                    Text("依頼と返答の見出し")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("補助パネルを閉じる")
            }
            .padding(14)

            Divider()

            if let summary = visibleSummary {
                DisclosureGroup {
                    Text(summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                } label: {
                    Label("会話の要約", systemImage: "text.quote")
                        .font(.caption.weight(.semibold))
                }
                .padding(12)
                .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
                .padding(8)

                Divider()
            }

            if entries.isEmpty {
                ContentUnavailableView(
                    "目次はまだありません",
                    systemImage: "list.bullet.indent",
                    description: Text("会話が進むと、依頼と返答の見出しがここに並びます。")
                )
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(entries) { entry in
                                Button {
                                    select(entry)
                                } label: {
                                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                                        Image(systemName: entry.kind == .request ? "person.fill" : "textformat")
                                            .font(.caption)
                                            .foregroundStyle(entry.kind == .request ? Color.secondary : Color.accentColor)
                                            .frame(width: 16)
                                        Text(entry.title)
                                            .font(entry.kind == .request ? .callout.weight(.medium) : .callout)
                                            .lineLimit(2)
                                            .multilineTextAlignment(.leading)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.leading, entry.kind == .heading ? CGFloat(max(0, entry.level - 1)) * 12 : 0)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 7)
                                    .contentShape(Rectangle())
                                    .background(
                                        activeEntryID == entry.id ? Color.accentColor.opacity(0.12) : .clear,
                                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    )
                                }
                                .buttonStyle(.plain)
                                .id(entry.id)
                                .accessibilityHint("会話内の該当位置へ移動")
                            }
                        }
                        .padding(6)
                    }
                    .onChange(of: activeEntryID) {
                        guard let activeEntryID else { return }
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                            proxy.scrollTo(activeEntryID, anchor: .center)
                        }
                    }
                }
            }
        }
    }
}

struct DesktopConversationOutlinePositionPreferenceKey: PreferenceKey {
    static let defaultValue: [String: CGFloat] = [:]

    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

struct DesktopConversationOutlineAnchorModifier: ViewModifier {
    static let coordinateSpaceName = "shannon.desktop.conversation.timeline"
    let id: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let id {
            content
                .id(id)
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(
                            key: DesktopConversationOutlinePositionPreferenceKey.self,
                            value: [id: geometry.frame(in: .named(Self.coordinateSpaceName)).minY]
                        )
                    }
                }
        } else {
            content
        }
    }
}

struct DesktopArtifactCard: View {
    let artifact: ShannonGeneratedArtifactDTO
    @State var isPreviewing = false

    var safeFilename: String {
        ShannonGeneratedArtifact.safeFilename(artifact.name, mimeType: artifact.mimeType)
    }

    var body: some View {
        Button {
            isPreviewing = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: ShannonGeneratedArtifact.isMarkdown(artifact) ? "doc.richtext" : "doc.text")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 34, height: 34)
                    .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text(safeFilename)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                    Text(artifact.summary ?? ByteCountFormatter.string(
                        fromByteCount: Int64(artifact.content.utf8.count),
                        countStyle: .file
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer()
                Text("プレビュー")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 0.75)
        }
        .sheet(isPresented: $isPreviewing) {
            DesktopArtifactPreview(
                artifact: artifact,
                safeFilename: safeFilename
            )
            .frame(minWidth: 620, minHeight: 500)
        }
    }
}

struct DesktopArtifactPreview: View {
    let artifact: ShannonGeneratedArtifactDTO
    let safeFilename: String
    @Environment(\.dismiss) var dismiss
    @State var isExporting = false
    @State var exportMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(safeFilename).font(.headline)
                    Text("保存先を選ぶまでMacには書き込みません")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let exportMessage {
                    Text(exportMessage)
                        .font(.caption)
                        .foregroundStyle(exportMessage == "保存しました" ? Color.secondary : Color.shannonAttention)
                }
                Button("閉じる") { dismiss() }
                Button("保存…") { isExporting = true }
                    .buttonStyle(.borderedProminent)
            }
            .padding(16)
            Divider()
            ScrollView {
                Group {
                    if ShannonGeneratedArtifact.isMarkdown(artifact) {
                        DesktopMarkdownView(source: artifact.content)
                    } else {
                        Text(artifact.content)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(24)
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
        .fileExporter(
            isPresented: $isExporting,
            document: ShannonArtifactDocument(content: artifact.content),
            contentType: artifact.exportContentType,
            defaultFilename: safeFilename
        ) { result in
            switch result {
            case .success:
                exportMessage = "保存しました"
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError {
                    exportMessage = "保存できませんでした: \(error.localizedDescription)"
                }
            }
        }
    }
}

struct DesktopMarkdownView: View {
    let source: String
    var messageID: UUID?

    init(source: String, messageID: UUID? = nil) {
        self.source = source
        self.messageID = messageID
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(ShannonMessageMarkdown.blocks(from: source).enumerated()), id: \.offset) { index, block in
                blockView(block)
                    .modifier(DesktopConversationOutlineAnchorModifier(id: anchorID(for: block, index: index)))
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func anchorID(for block: ShannonMessageMarkdown.Block, index: Int) -> String? {
        guard case .heading = block, let messageID else { return nil }
        return ShannonDesktopConversationOutline.headingAnchorID(messageID: messageID, blockIndex: index)
    }

    @ViewBuilder
    func blockView(_ block: ShannonMessageMarkdown.Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(ShannonMessageMarkdown.render(text))
                .font(level <= 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, level <= 2 ? 6 : 2)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•")
                Text(ShannonMessageMarkdown.render(text))
            }
        case .numbered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker).foregroundStyle(.secondary)
                Text(ShannonMessageMarkdown.render(text))
            }
        case .quote(let text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accentColor)
                    .frame(width: 3)
                Text(ShannonMessageMarkdown.render(text))
                    .foregroundStyle(.secondary)
            }
        case .code(let text):
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
            }
            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
        case .divider:
            Divider()
        case .paragraph(let text):
            Text(ShannonMessageMarkdown.render(text))
        }
    }
}
