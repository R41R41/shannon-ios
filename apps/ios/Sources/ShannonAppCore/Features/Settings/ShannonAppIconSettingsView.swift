import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct ShannonAppIconSettingsView: View {
    let model: ShannonAppIconModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    public init(model: ShannonAppIconModel) {
        self.model = model
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                    currentSelection(palette)

                    VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                        Text("アイコンを選ぶ")
                            .font(.headline)
                            .foregroundStyle(palette.textPrimary)
                        Text("L06が標準です。選択はこの端末に保存されます。")
                            .font(.subheadline)
                            .foregroundStyle(palette.textSecondary)
                    }

                    LazyVGrid(columns: columns, spacing: ShannonSpacing.medium) {
                        ForEach(ShannonAppIconChoice.selectableChoices) { choice in
                            choiceButton(choice, palette: palette)
                        }
                    }

                    if model.isUpdating {
                        ProgressView("アイコンを変更中")
                            .frame(maxWidth: .infinity)
                    }

                    if let errorMessage = model.errorMessage {
                        ShannonSnackbar(
                            message: errorMessage,
                            showsRetry: false,
                            retry: {},
                            dismiss: model.dismissError
                        )
                    }
                }
                .padding(ShannonSpacing.large)
            }
            .background(palette.readingSurface)
            .navigationTitle("アプリアイコン")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
        }
        .frame(minWidth: 360, idealWidth: 560, minHeight: 420, idealHeight: 560)
    }

    private func currentSelection(_ palette: ShannonPalette) -> some View {
        HStack(spacing: ShannonSpacing.large) {
            ShannonAppIconPreview(
                assetName: model.activeChoice.previewAssetName,
                size: 76,
                accessibilityLabel: "現在のアプリアイコン"
            )
            VStack(alignment: .leading, spacing: 3) {
                Text("現在のアイコン")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                Text(model.activeTitle)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                if model.activeChoice == .defaultChoice {
                    Text("標準・おすすめ")
                        .font(.subheadline)
                        .foregroundStyle(palette.action)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(ShannonSpacing.large)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider, lineWidth: 0.7)
        }
    }

    private func choiceButton(_ choice: ShannonAppIconChoice, palette: ShannonPalette) -> some View {
        let isSelected = model.selectedChoice == choice

        return Button {
            Task { await model.select(choice) }
        } label: {
            VStack(spacing: ShannonSpacing.small) {
                ZStack(alignment: .topTrailing) {
                    ShannonAppIconPreview(
                        assetName: choice.previewAssetName,
                        size: 84,
                        accessibilityLabel: "\(choice.levelName) \(choice.japaneseName)のアイコン"
                    )
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title2)
                            .foregroundStyle(palette.action)
                            .background(.background, in: Circle())
                            .offset(x: 5, y: -5)
                    }
                }
                Text(choice.levelName)
                    .font(.headline.monospaced())
                Text(choice.japaneseName)
                    .font(.callout.weight(.semibold))
                Text(choice.detail)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .foregroundStyle(palette.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 168)
            .padding(ShannonSpacing.small)
            .background(
                isSelected ? palette.userMessage : palette.canvas,
                in: RoundedRectangle(cornerRadius: ShannonShape.large)
            )
            .overlay {
                RoundedRectangle(cornerRadius: ShannonShape.large)
                    .stroke(isSelected ? palette.action : palette.divider, lineWidth: isSelected ? 2 : 0.7)
            }
        }
        .buttonStyle(.plain)
        .disabled(model.isUpdating)
        .accessibilityValue(isSelected ? "選択中" : "未選択")
    }

    private var columns: [GridItem] {
#if os(macOS)
        Array(repeating: GridItem(.flexible(), spacing: ShannonSpacing.medium), count: 3)
#else
        [GridItem(.flexible(), spacing: ShannonSpacing.small), GridItem(.flexible(), spacing: ShannonSpacing.small)]
#endif
    }
}

struct ShannonAppIconPreview: View {
    let assetName: String
    let size: CGFloat
    let accessibilityLabel: String

    var body: some View {
        previewImage
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                    .stroke(.black.opacity(0.08), lineWidth: 0.7)
            }
            .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
            .accessibilityLabel(accessibilityLabel)
    }

    private var previewImage: Image {
#if canImport(UIKit)
        if let image = ShannonAppIconAssets.uiImage(for: assetName) {
            return Image(uiImage: image)
        }
        return Image(systemName: "app.dashed")
#elseif canImport(AppKit)
        if let image = ShannonAppIconAssets.nsImage(for: assetName) {
            return Image(nsImage: image)
        }
        return Image(systemName: "app.dashed")
#else
        return Image(systemName: "app.dashed")
#endif
    }
}

struct ShannonEnvironmentPaletteReader<Content: View>: View {
    @Environment(\.colorScheme) var colorScheme
    let content: (ShannonPalette) -> Content

    init(@ViewBuilder content: @escaping (ShannonPalette) -> Content) {
        self.content = content
    }

    var body: some View {
        content(ShannonPalette.resolve(colorScheme))
    }
}
