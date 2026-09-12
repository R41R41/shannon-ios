import SwiftUI
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func composer(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
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
    }

    var composerTextField: some View {
        TextField("シャノンに話す", text: $model.draft, axis: .vertical)
            .font(.body)
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
                        .font(.caption)
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
            .font(.caption.weight(.medium))
            .foregroundStyle(palette.action)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(palette.action.opacity(0.10), in: Capsule())
            .padding(.horizontal, 6)
        }

        if let composerAttachmentError {
            Label(composerAttachmentError, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(palette.attention)
                .padding(.horizontal, 10)
        }
    }

    func composerToolsButton(_ palette: ShannonPalette) -> some View {
        Menu {
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
            Text("テキスト・Markdown・コードを4件まで")
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(palette.textPrimary)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        .buttonStyle(.plain)
        .disabled(model.isSending)
        .accessibilityLabel("添付とWeb検索")
    }

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
        .disabled(model.isSending || [.requestingPermission, .transcribing, .thinking].contains(voiceModel.phase))
        .accessibilityLabel(voiceModel.phase == .listening ? "音声入力を終了" : "音声入力")
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
