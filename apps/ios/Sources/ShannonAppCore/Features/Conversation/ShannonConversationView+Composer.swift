import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func composer(_ palette: M3Palette) -> some View {
        ShannonAdaptiveComposerLayout(
            isExpanded: composerIsExpanded,
            spacing: M3Spacing.extraSmall
        ) {
            composerTextField
            composerMenuButton(palette)
            transcriptionButton(palette)
            composerPrimaryButton(palette)
        }
        .padding(6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: composerIsExpanded ? 24 : M3Shape.extraLarge, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: composerIsExpanded ? 24 : M3Shape.extraLarge, style: .continuous)
                .stroke(palette.outlineVariant.opacity(composerIsFocused ? 0.95 : 0.62), lineWidth: composerIsFocused ? 1.2 : 0.7)
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.top, M3Spacing.small)
        .padding(.bottom, M3Spacing.small)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: composerIsExpanded)
    }

    var composerTextField: some View {
        TextField("シャノンに話す", text: $model.draft, axis: .vertical)
            .font(.body)
            .lineLimit(1...6)
            .frame(minHeight: 40)
            .focused($composerIsFocused)
            .onSubmit { sendDraft() }
            .submitLabel(.send)
            .accessibilityIdentifier("shannon.composer.field")
            .accessibilityHint("複数行入力できます")
    }

    func composerMenuButton(_ palette: M3Palette) -> some View {
        Menu {
            Button(action: createThreadFromHeader) {
                Label("新しいトーク", systemImage: "square.and.pencil")
            }
            Button(action: toggleDisplayMode) {
                Label("(displayMode.switchActionTitle)表示へ切り替える", systemImage: displayMode.switchActionSymbolName)
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(palette.onTertiary)
                .frame(width: 40, height: 40)
                .background(palette.tertiary, in: Circle())
                .contentShape(Circle())
        }
        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
        .buttonStyle(.plain)
        .disabled(model.isSending)
        .accessibilityLabel("追加操作")
    }

    func transcriptionButton(_ palette: M3Palette) -> some View {
        Button(action: performTranscriptionPrimaryAction) {
            Image(systemName: voiceModel.phase == .listening ? "stop.fill" : "mic")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(voiceModel.phase == .listening ? palette.onPrimary : palette.onSurface)
                .frame(width: 40, height: 40)
                .background(
                    voiceModel.phase == .listening ? palette.primary : Color.clear,
                    in: Circle()
                )
                .contentShape(Circle())
        }
        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
        .buttonStyle(.plain)
        .disabled(model.isSending || [.requestingPermission, .transcribing, .thinking].contains(voiceModel.phase))
        .accessibilityLabel(voiceModel.phase == .listening ? "音声入力を終了" : "音声入力")
    }

    func composerPrimaryButton(_ palette: M3Palette) -> some View {
        Button(action: composerPrimaryAction) {
            ZStack {
                Circle()
                    .fill(composerActionIsEnabled ? palette.primary : palette.surfaceContainer)
                if model.isSending || voiceModel.phase == .requestingPermission || voiceModel.phase == .thinking {
                    ProgressView()
                        .tint(palette.onSurfaceVariant)
                        .controlSize(.small)
                } else {
                    Image(systemName: composerActionSymbol)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(composerActionIsEnabled ? palette.onPrimary : palette.onSurfaceVariant)
                }
            }
            .frame(width: 40, height: 40)
        }
        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
        .buttonStyle(.plain)
        .disabled(!composerActionIsEnabled)
        .accessibilityLabel(composerActionLabel)
    }
}
