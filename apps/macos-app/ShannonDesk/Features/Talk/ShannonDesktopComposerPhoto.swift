import AppKit
import PhotosUI
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

/// The composer's photo (roadmap A14): one photo with the files, four in all, as on the iPhone.
extension DesktopComposer {
    var attachmentCount: Int { attachments.count + (photo == nil ? 0 : 1) }

    @ViewBuilder
    var photoContext: some View {
        if let photoPreview {
            HStack(spacing: ShannonDesktopSpacing.small) {
                Image(nsImage: photoPreview)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: ShannonDesktopRadius.small))
                    .accessibilityLabel("送信前の写真")
                Text("写真を添付")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
                Button {
                    clearPhoto()
                    attachmentError = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("写真を外す")
                .accessibilityLabel("写真を外す")
            }
        }
        if isPreparingPhoto {
            ProgressView("写真を準備中")
                .controlSize(.small)
                .font(.shannonDesktop(.caption))
        }
    }

    func clearPhoto() {
        photo = nil
        photoPreview = nil
        photoPickerItem = nil
    }

    /// Text files become attachments; an image file becomes the photo.
    func importFiles(_ result: Result<[URL], Error>) {
        do {
            let urls = try result.get()
            let images = urls.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }
            let texts = urls.filter { !images.contains($0) }
            if images.count > 1 || (images.count == 1 && photo != nil) {
                attachmentError = "写真は1枚まで添付できます。"
                return
            }
            guard attachmentCount + urls.count <= ShannonChatAttachmentLimits.maximumCount else {
                throw ShannonDesktopAttachmentError.tooManyFiles
            }
            if !texts.isEmpty {
                attachments = try ShannonDesktopAttachmentLoader.load(urls: texts, existing: attachments)
            }
            attachmentError = nil
            if let image = images.first {
                let accessed = image.startAccessingSecurityScopedResource()
                defer { if accessed { image.stopAccessingSecurityScopedResource() } }
                usePhoto(try ShannonChatPhoto.prepare(Data(contentsOf: image, options: [.mappedIfSafe])))
            }
        } catch {
            attachmentError = (error as? LocalizedError)?.errorDescription ?? "ファイルを追加できませんでした。"
        }
    }

    func loadPickedPhoto(_ item: PhotosPickerItem) async {
        isPreparingPhoto = true
        defer { isPreparingPhoto = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw ShannonChatPhoto.Failure.invalidImage
            }
            guard photoPickerItem == item else { return }
            usePhoto(try ShannonChatPhoto.prepare(data))
            attachmentError = nil
        } catch {
            guard photoPickerItem == item else { return }
            photoPickerItem = nil
            attachmentError = (error as? LocalizedError)?.errorDescription ?? "写真を読み込めませんでした。別の写真を選んでください。"
        }
    }

    private func usePhoto(_ prepared: ShannonChatPhoto) {
        photo = prepared
        photoPreview = NSImage(data: prepared.jpegData)
    }
}
