#if os(iOS)
import SwiftUI
import UIKit

struct ShannonVoicePhotoPreview: View {
    let image: UIImage
    let palette: ShannonPalette
    let fromLibrary: Bool
    let isSharing: Bool
    let remove: () -> Void
    let chooseAgain: () -> Void
    let share: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: ShannonSpacing.medium) {
                previewImage
                actions
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                previewImage
                actions
            }
        }
        .padding(ShannonSpacing.small)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
    }

    private var previewImage: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: 72, height: 72)
            .clipShape(RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
            .accessibilityLabel("共有前の写真")
            .overlay(alignment: .topTrailing) {
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill")
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("写真を外す")
            }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("この1枚だけを共有します")
                .font(.callout.weight(.semibold))
            Text("シャノンが見た内容を音声会話へ戻します")
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
            HStack(spacing: ShannonSpacing.small) {
                Button(fromLibrary ? "選び直す" : "撮り直す", action: chooseAgain)
                    .buttonStyle(.bordered)
                    .frame(minHeight: ShannonTouchTarget.minimum)

                Button(action: share) {
                    if isSharing {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("共有")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.action)
                .frame(minHeight: ShannonTouchTarget.minimum)
                .disabled(isSharing)
            }
            .controlSize(.regular)
        }
    }
}
#endif
