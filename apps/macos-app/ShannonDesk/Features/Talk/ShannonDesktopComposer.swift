import AppKit
import PhotosUI
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopComposer: View {
    @Bindable var model: ShannonConversationModel
    @State var attachments: [ShannonChatAttachmentDTO] = []
    @State var isImporting = false
    @State var attachmentError: String?
    @State var usesWebSearch = false
    /// One photo, as on the iPhone: from Photos or an image file, prepared in memory (A14).
    @State var photo: ShannonChatPhoto?
    @State var photoPreview: NSImage?
    @State var isPickingPhoto = false
    @State var photoPickerItem: PhotosPickerItem?
    @State var isPreparingPhoto = false

    init(model: ShannonConversationModel) {
        self.model = model
#if DEBUG
        _attachments = State(initialValue: model.isDesignPreview ? [
            ShannonChatAttachmentDTO(
                name: "shannon-interface-plan.md",
                mimeType: "text/markdown",
                text: "# Shannon Desk\n会話と作業を一つの流れにする。"
            )
        ] : [])
        _usesWebSearch = State(initialValue: model.isDesignPreview)
#endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonDesktopSpacing.small) {
            photoContext
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: ShannonDesktopSpacing.small) {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { index, attachment in
                            HStack(spacing: 7) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(attachment.name)
                                        .font(.shannonDesktop(.caption).weight(.medium))
                                        .lineLimit(1)
                                    Text(ByteCountFormatter.string(
                                        fromByteCount: Int64(attachment.text.utf8.count),
                                        countStyle: .file
                                    ))
                                    .font(.shannonDesktop(.caption2))
                                    .foregroundStyle(.secondary)
                                }
                                Button {
                                    attachments.remove(at: index)
                                    attachmentError = nil
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.tertiary)
                                }
                                .buttonStyle(.plain)
                                .help("添付を外す")
                            }
                            .padding(.leading, ShannonDesktopSpacing.medium)
                            .padding(.trailing, 7)
                            .padding(.vertical, 7)
                            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium))
                        }
                    }
                }
            }

            if let attachmentError {
                Label(attachmentError, systemImage: "exclamationmark.triangle")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(Color.shannonAttention)
            }

            if usesWebSearch {
                HStack(spacing: 7) {
                    Image(systemName: "globe")
                    Text("Webで調べる")
                        .font(.shannonDesktop(.caption).weight(.medium))
                    Button {
                        usesWebSearch = false
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Web検索を外す")
                }
                .foregroundStyle(Color.shannonActionColor)
                .padding(.horizontal, ShannonDesktopSpacing.medium)
                .padding(.vertical, 7)
                .background(Color.shannonActionColor.opacity(0.10), in: Capsule())
            }

            TextField("シャノンに話す", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .font(.shannonDesktop(.body))

            HStack {
                Menu {
                    Button("写真ライブラリから追加", systemImage: "photo.on.rectangle") {
                        isPickingPhoto = true
                    }
                    .disabled(attachmentCount >= ShannonChatAttachmentLimits.maximumCount)
                    Button("ファイルを追加", systemImage: "paperclip") {
                        isImporting = true
                    }
                    Button(
                        usesWebSearch ? "Web検索を外す" : "Webで調べる",
                        systemImage: usesWebSearch ? "checkmark.circle" : "globe"
                    ) {
                        usesWebSearch.toggle()
                    }
                    Divider()
                    Text("写真とファイルを合わせて4件まで")
                    Text("Web検索は明示的に選んだ送信だけで使用")
                } label: {
                    Image(systemName: "paperclip")
                }
                .menuStyle(.borderlessButton)
                .help("添付とツール")

                Spacer()
                Text("⌘↩︎で送信")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.tertiary)
                Button {
                    let selectedAttachments = attachments
                    let selectedWebSearch = usesWebSearch
                    let selectedPhoto = photo?.jpegData
                    attachments = []
                    usesWebSearch = false
                    attachmentError = nil
                    clearPhoto()
                    Task {
                        await model.sendDraft(
                            attachments: selectedAttachments,
                            webSearch: selectedWebSearch,
                            photoJPEGData: selectedPhoto
                        )
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(isPreparingPhoto || !model.canSendDraft(attachmentCount: attachmentCount))
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(ShannonDesktopSpacing.medium)
        .frame(maxWidth: 780)
        .frame(maxWidth: .infinity)
        .fileImporter(
            isPresented: $isImporting,
            allowedContentTypes: [.plainText, .sourceCode, .json, .commaSeparatedText, .image],
            allowsMultipleSelection: true
        ) { result in
            importFiles(result)
        }
        .photosPicker(isPresented: $isPickingPhoto, selection: $photoPickerItem, matching: .images)
        .shannonCoversFigure(isImporting || isPickingPhoto)
        .onChange(of: photoPickerItem) {
            guard let photoPickerItem else { return }
            Task { await loadPickedPhoto(photoPickerItem) }
        }
        .onChange(of: model.selectedThreadId) {
            attachments = []
            usesWebSearch = false
            attachmentError = nil
            clearPhoto()
        }
    }
}
