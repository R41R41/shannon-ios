import SwiftUI
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
import PhotosUI
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func composer(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            ShannonNowCompact(model: now)
            composerContext(palette)

            ShannonAdaptiveComposerLayout(
                isExpanded: composerIsExpanded,
                spacing: ShannonSpacing.extraSmall
            ) {
                composerTextField
                composerToolsButton(palette)
                transcriptionButton(palette)
                composerPrimaryButton(palette)
            }
        }
        .padding(6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: composerIsExpanded ? 24 : ShannonShape.extraLarge, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: composerIsExpanded ? 24 : ShannonShape.extraLarge, style: .continuous)
                .stroke(palette.divider.opacity(composerIsFocused ? 0.95 : 0.62), lineWidth: composerIsFocused ? 1.2 : 0.7)
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .padding(.top, ShannonSpacing.small)
        .padding(.bottom, ShannonSpacing.small)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: composerIsExpanded)
        .fileImporter(
            isPresented: $composerIsImporting,
            allowedContentTypes: [.plainText, .sourceCode, .json, .commaSeparatedText],
            allowsMultipleSelection: true,
            onCompletion: importComposerAttachments
        )
#if os(iOS)
        .photosPicker(isPresented: $composerIsPickingPhoto, selection: $composerPhotoPickerItem, matching: .images)
        .onChange(of: composerPhotoPickerItem) {
            guard let composerPhotoPickerItem else { return }
            Task { await loadComposerPhoto(composerPhotoPickerItem) }
        }
#endif
    }

    var composerTextField: some View {
        TextField("シャノンに話す", text: $model.draft, axis: .vertical)
            .font(.shannon(.body))
            .lineLimit(1...6)
            .frame(minHeight: 40)
            .padding(.horizontal, 10)
            .focused($composerIsFocused)
            .onSubmit { sendDraft() }
            .submitLabel(.send)
            .accessibilityIdentifier("shannon.composer.field")
            .accessibilityHint("複数行入力できます")
    }

    @ViewBuilder
    func composerContext(_ palette: ShannonPalette) -> some View {
#if os(iOS)
        if let composerPhoto {
            HStack(spacing: ShannonSpacing.small) {
                Image(uiImage: composerPhoto.preview)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: ShannonShape.small))
                    .accessibilityLabel("送信前の写真")
                Text("写真を添付")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                Button {
                    self.composerPhoto = nil
                    composerAttachmentError = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("写真を外す")
            }
            .padding(.horizontal, 6)
        }
        if composerIsLoadingPhoto {
            ProgressView("写真を準備中")
                .font(.shannon(.caption))
                .padding(.horizontal, 10)
        }
#endif
        if !composerAttachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: ShannonSpacing.extraSmall) {
                    ForEach(Array(composerAttachments.enumerated()), id: \.offset) { index, attachment in
                        HStack(spacing: 6) {
                            Image(systemName: "doc.text")
                            Text(attachment.name).lineLimit(1)
                            Button {
                                composerAttachments.remove(at: index)
                                composerAttachmentError = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(attachment.name)を外す")
                        }
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .background(palette.subtleSurface, in: Capsule())
                    }
                }
                .padding(.horizontal, 6)
            }
        }

        if composerUsesWebSearch {
            HStack(spacing: 6) {
                Image(systemName: "globe")
                Text("Webで調べる")
                Button {
                    composerUsesWebSearch = false
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Web検索を外す")
            }
            .font(.shannon(.caption).weight(.medium))
            .foregroundStyle(palette.action)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(palette.action.opacity(0.10), in: Capsule())
            .padding(.horizontal, 6)
        }

        if let composerAttachmentError {
            Label(composerAttachmentError, systemImage: "exclamationmark.triangle")
                .font(.shannon(.caption))
                .foregroundStyle(palette.attention)
                .padding(.horizontal, 10)
        }
    }

    func composerToolsButton(_ palette: ShannonPalette) -> some View {
        Menu {
#if os(iOS)
            Button {
                composerIsPickingPhoto = true
            } label: {
                Label("写真ライブラリから追加", systemImage: "photo.on.rectangle")
            }
            .disabled(composerAttachments.count >= ShannonChatAttachmentLimits.maximumCount)
#endif
            Button {
                composerIsImporting = true
            } label: {
                Label("ファイルを追加", systemImage: "paperclip")
            }

            Button {
                composerUsesWebSearch.toggle()
            } label: {
                Label(
                    composerUsesWebSearch ? "Web検索を外す" : "Webで調べる",
                    systemImage: composerUsesWebSearch ? "checkmark.circle" : "globe"
                )
            }

            Divider()
            Text("写真とファイルを合わせて4件まで")
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(palette.textPrimary)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        .buttonStyle(.plain)
        .disabled(model.isSending || composerIsSubmitting || composerPhotoIsLoading)
        .accessibilityLabel("添付とWeb検索")
    }

    var composerPhotoIsLoading: Bool {
#if os(iOS)
        composerIsLoadingPhoto
#else
        false
#endif
    }

#if os(iOS)
    @MainActor
    func loadComposerPhoto(_ item: PhotosPickerItem) async {
        composerIsLoadingPhoto = true
        defer {
            if composerPhotoPickerItem == item {
                composerIsLoadingPhoto = false
                composerPhotoPickerItem = nil
            }
        }
        do {
            let photo = try await ShannonPhotoLibrarySelection.prepare(item)
            guard composerPhotoPickerItem == item else { return }
            guard composerAttachments.count < ShannonChatAttachmentLimits.maximumCount else {
                composerAttachmentError = "写真とファイルは合わせて4件までです。"
                return
            }
            composerPhoto = photo
            composerAttachmentError = nil
        } catch {
            guard composerPhotoPickerItem == item else { return }
            composerAttachmentError = (error as? LocalizedError)?.errorDescription
                ?? "写真を読み込めませんでした。別の写真を選んでください。"
        }
    }
#endif

    func transcriptionButton(_ palette: ShannonPalette) -> some View {
        Button(action: performTranscriptionPrimaryAction) {
            Image(systemName: voiceModel.phase == .listening ? "stop.fill" : "mic")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(voiceModel.phase == .listening ? palette.onAction : palette.textPrimary)
                .frame(width: 40, height: 40)
                .background(
                    voiceModel.phase == .listening ? palette.action : Color.clear,
                    in: Circle()
                )
                .contentShape(Circle())
        }
        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        .buttonStyle(.plain)
        .disabled(model.isSending || [.requestingPermission, .transcribing, .thinking].contains(voiceModel.phase)
            || dictationWaitsForCall)
        .accessibilityLabel(voiceModel.phase == .listening ? "音声入力を終了" : "音声入力")
        .accessibilityHint(dictationWaitsForCall ? ShannonGeneratedStrings.talkDictationWaitsForCall : "")
    }

    /// A tap would start dictation while the voice conversation holds the microphone: it waits. Finishing
    /// or stopping dictation that already runs (listening, ready, speaking) is never held back.
    var dictationWaitsForCall: Bool {
        Self.dictationWaits(dictation: voiceModel.phase, callHoldsMicrophone: voiceCallHoldsMicrophone)
    }

    nonisolated static func dictationWaits(dictation: ShannonVoicePhase, callHoldsMicrophone: Bool) -> Bool {
        callHoldsMicrophone && [.idle, .denied, .failed].contains(dictation)
    }

    /// The voice conversation holds the microphone: a call, or the few seconds after her spoken line for a
    /// touch when she listens for his answer. Dictation does not start then; two captures never run at once.
    var voiceCallHoldsMicrophone: Bool {
#if os(iOS)
        Self.callHoldsMicrophone(geminiLiveVoiceModel.phase)
#else
        false
#endif
    }

    nonisolated static func callHoldsMicrophone(_ phase: ShannonGeminiLivePhase) -> Bool {
        phase != .idle && phase != .failed
    }

    func composerPrimaryButton(_ palette: ShannonPalette) -> some View {
        Button(action: composerPrimaryAction) {
            ZStack {
                Circle()
                    .fill(composerActionIsEnabled ? palette.action : palette.subtleSurface)
                if model.isSending || voiceModel.phase == .requestingPermission || voiceModel.phase == .thinking {
                    ProgressView()
                        .tint(palette.textSecondary)
                        .controlSize(.small)
                } else {
                    Image(systemName: composerActionSymbol)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(composerActionIsEnabled ? palette.onAction : palette.textSecondary)
                }
            }
            .frame(width: 40, height: 40)
        }
        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        .buttonStyle(.plain)
        .disabled(!composerActionIsEnabled)
        .accessibilityLabel(composerActionLabel)
    }
}
