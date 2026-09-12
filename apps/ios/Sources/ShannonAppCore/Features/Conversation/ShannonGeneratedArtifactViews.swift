import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct ShannonGeneratedArtifactCard: View {
    let artifact: ShannonGeneratedArtifactDTO
    let palette: ShannonPalette
    @State var isPreviewing = false

    var safeFilename: String {
        ShannonGeneratedArtifact.safeFilename(artifact.name, mimeType: artifact.mimeType)
    }

    var body: some View {
        Button {
            isPreviewing = true
        } label: {
            HStack(spacing: ShannonSpacing.medium) {
                Image(systemName: ShannonGeneratedArtifact.isMarkdown(artifact) ? "doc.richtext" : "doc.text")
                    .font(.title3)
                    .foregroundStyle(palette.action)
                    .frame(width: 36, height: 36)
                    .background(palette.action.opacity(0.10), in: RoundedRectangle(cornerRadius: ShannonShape.small))
                VStack(alignment: .leading, spacing: 2) {
                    Text(safeFilename)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                        .lineLimit(1)
                    Text(artifact.summary ?? ByteCountFormatter.string(
                        fromByteCount: Int64(artifact.content.utf8.count),
                        countStyle: .file
                    ))
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
            }
            .padding(ShannonSpacing.medium)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            palette.subtleSurface,
            in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous)
                .stroke(palette.divider.opacity(0.55), lineWidth: 0.7)
        }
        .accessibilityLabel("生成物 \(safeFilename)をプレビュー")
        .sheet(isPresented: $isPreviewing) {
            ShannonGeneratedArtifactPreview(
                artifact: artifact,
                safeFilename: safeFilename
            )
        }
    }
}

struct ShannonGeneratedArtifactPreview: View {
    let artifact: ShannonGeneratedArtifactDTO
    let safeFilename: String
    @Environment(\.dismiss) var dismiss
    @Environment(\.colorScheme) var colorScheme
    @State var isExporting = false
    @State var exportMessage: String?

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                Group {
                    if ShannonGeneratedArtifact.isMarkdown(artifact) {
                        ShannonRichMarkdownText(source: artifact.content, palette: palette)
                    } else {
                        Text(artifact.content)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(ShannonSpacing.large)
            }
            .background(palette.canvas)
            .navigationTitle(safeFilename)
            .safeAreaInset(edge: .bottom) {
                if let exportMessage {
                    Text(exportMessage)
                        .font(.caption)
                        .foregroundStyle(exportMessage == "保存しました" ? palette.success : palette.attention)
                        .padding(.horizontal, ShannonSpacing.medium)
                        .padding(.vertical, ShannonSpacing.small)
                        .background(.regularMaterial, in: Capsule())
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        isExporting = true
                    } label: {
                        Label("ファイルに保存", systemImage: "square.and.arrow.down")
                    }
                }
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: ShannonArtifactFileDocument(content: artifact.content, contentType: exportContentType),
            contentType: exportContentType,
            defaultFilename: safeFilename
        ) { result in
            switch result {
            case .success:
                exportMessage = "保存しました"
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError {
                    exportMessage = "保存できませんでした"
                }
            }
        }
    }

    var exportContentType: UTType {
        switch artifact.mimeType {
        case "text/markdown": .init(filenameExtension: "md") ?? .plainText
        case "application/json": .json
        case "text/csv": .commaSeparatedText
        default: .plainText
        }
    }
}

struct ShannonArtifactFileDocument: FileDocument {
    static let markdownContentType = UTType(filenameExtension: "md") ?? .plainText

    static var readableContentTypes: [UTType] {
        [.plainText, .json, .commaSeparatedText, markdownContentType]
    }

    let content: String
    let contentType: UTType

    init(content: String, contentType: UTType) {
        self.content = content
        self.contentType = contentType
    }

    init(configuration: ReadConfiguration) throws {
        let data = configuration.file.regularFileContents ?? Data()
        content = String(decoding: data, as: UTF8.self)
        contentType = configuration.contentType
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(content.utf8))
    }
}
