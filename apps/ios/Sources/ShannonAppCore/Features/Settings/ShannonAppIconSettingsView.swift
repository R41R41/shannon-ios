import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonAppIconSettingsView: View {
    let model: ShannonAppIconModel
    let expression: ShannonExpressionDTO

    @Environment(\.dismiss) var dismiss
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                    HStack(spacing: ShannonSpacing.large) {
                        ShannonAppIconPreview(
                            assetName: previewAssetName(for: model.activeChoice ?? appearanceChoice),
                            size: 76,
                            accessibilityLabel: "現在のアイコン"
                        )
                        VStack(alignment: .leading, spacing: 3) {
                            Text("現在のアイコン")
                                .font(.caption)
                                .foregroundStyle(palette.textSecondary)
                            Text(model.activeTitle)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(palette.textPrimary)
                            Text(model.mode.japaneseName)
                                .font(.subheadline)
                                .foregroundStyle(palette.textSecondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(ShannonSpacing.large)
                    .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
                    .overlay {
                        RoundedRectangle(cornerRadius: ShannonShape.large)
                            .stroke(palette.divider, lineWidth: 0.7)
                    }

                    Text("変更方法")
                        .font(.headline)
                        .foregroundStyle(palette.textPrimary)

                    VStack(spacing: ShannonSpacing.small) {
                        ForEach(ShannonAppIconMode.allCases) { mode in
                            Button {
                                Task {
                                    await model.selectMode(
                                        mode,
                                        expression: expression,
                                        appearance: iconAppearance
                                    )
                                }
                            } label: {
                                HStack(spacing: ShannonSpacing.medium) {
                                    modePreview(for: mode)

                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(mode.japaneseName)
                                            .font(.body.weight(.semibold))
                                        Text(modeDetail(for: mode))
                                            .font(.caption)
                                            .foregroundStyle(palette.textSecondary)
                                            .multilineTextAlignment(.leading)
                                    }
                                    .foregroundStyle(palette.textPrimary)

                                    Spacer(minLength: ShannonSpacing.small)

                                    Image(systemName: model.mode == mode ? "checkmark.circle.fill" : "circle")
                                        .font(.title3)
                                        .foregroundStyle(
                                            model.mode == mode
                                                ? palette.action
                                                : palette.divider
                                        )
                                }
                                .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
                                .padding(.horizontal, ShannonSpacing.medium)
                                .padding(.vertical, ShannonSpacing.small)
                                .background(
                                    model.mode == mode
                                        ? palette.userMessage
                                        : palette.canvas,
                                    in: RoundedRectangle(cornerRadius: ShannonShape.large)
                                )
                                .overlay {
                                    RoundedRectangle(cornerRadius: ShannonShape.large)
                                        .stroke(
                                            model.mode == mode
                                                ? palette.action
                                                : palette.divider,
                                            lineWidth: model.mode == mode ? 2 : 0.7
                                        )
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(model.isUpdating)
                        }
                    }

                    if model.mode == .manual {
                        iconChoiceGrid(
                            title: "アイコン",
                            choices: ShannonAppIconChoice.manualChoices,
                            palette: palette
                        )
                    }

                    if model.isUpdating {
                        ProgressView()
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
    }

    @ViewBuilder
    func modePreview(for mode: ShannonAppIconMode) -> some View {
        switch mode {
        case .automatic:
            ZStack(alignment: .leading) {
                ForEach(Array(automaticPreviewChoices.enumerated()), id: \.element.id) { index, choice in
                    ShannonAppIconPreview(
                        assetName: choice.previewAssetName,
                        size: 42,
                        accessibilityLabel: "\(choice.japaneseName)のアイコン"
                    )
                    .offset(x: CGFloat(index) * 11)
                    .zIndex(Double(automaticPreviewChoices.count - index))
                }
            }
            .frame(width: 66, height: 56, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("時刻と感情で変わるアイコン")
        case .appearance:
            ZStack(alignment: .leading) {
                ShannonAppIconPreview(
                    assetName: ShannonAppIconChoice.light.previewAssetName,
                    size: 48,
                    accessibilityLabel: "ライトアイコン"
                )
                ShannonAppIconPreview(
                    assetName: ShannonAppIconChoice.dark.previewAssetName,
                    size: 48,
                    accessibilityLabel: "ダークアイコン"
                )
                .offset(x: 18)
            }
            .frame(width: 66, height: 56, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("アプリのライト・ダークモードに連動するアイコン")
        case .manual:
            ShannonAppIconPreview(
                assetName: previewAssetName(for: model.manualChoice),
                size: 56,
                accessibilityLabel: "選択中の\(model.manualChoice.japaneseName)アイコン"
            )
        }
    }

    var automaticPreviewChoices: [ShannonAppIconChoice] {
        let preferred = model.mode == .automatic
            ? model.activeChoice ?? ShannonAppIconChoice.matching(expression)
            : ShannonAppIconChoice.matching(expression)
        return [preferred, .sleepy, .sleeping].reduce(into: []) { choices, choice in
            if !choices.contains(choice) {
                choices.append(choice)
            }
        }
    }

    func modeDetail(for mode: ShannonAppIconMode) -> String {
        switch mode {
        case .automatic:
            "時刻とシャノンの感情で変化"
        case .appearance:
            "アプリ内のライト・ダーク表示と一緒に切替"
        case .manual:
            "\(model.manualChoice.japaneseName)を使用"
        }
    }

    @ViewBuilder
    func iconChoiceGrid(
        title: String,
        choices: [ShannonAppIconChoice],
        palette: ShannonPalette
    ) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(palette.textPrimary)

        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: ShannonSpacing.small),
                GridItem(.flexible(), spacing: ShannonSpacing.small),
            ],
            spacing: ShannonSpacing.small
        ) {
            ForEach(choices) { choice in
                Button {
                    Task { await model.selectManualChoice(choice) }
                } label: {
                    VStack(spacing: ShannonSpacing.small) {
                        ShannonAppIconPreview(
                            assetName: previewAssetName(for: choice),
                            size: 72,
                            accessibilityLabel: "\(choice.japaneseName)のアイコン"
                        )
                        Text(choice.japaneseName)
                            .font(.callout.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(
                        model.manualChoice == choice
                            ? palette.onUserMessage
                            : palette.textPrimary
                    )
                    .frame(maxWidth: .infinity, minHeight: 122)
                    .background(
                        model.manualChoice == choice
                            ? palette.userMessage
                            : palette.canvas,
                        in: RoundedRectangle(cornerRadius: ShannonShape.large)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: ShannonShape.large)
                            .stroke(
                                model.manualChoice == choice
                                    ? palette.action
                                    : palette.divider,
                                lineWidth: model.manualChoice == choice ? 2 : 0.7
                            )
                    }
                }
                .buttonStyle(.plain)
                .disabled(model.isUpdating)
            }
        }
    }

    func previewAssetName(for choice: ShannonAppIconChoice) -> String {
        choice.previewAssetName
    }

    var iconAppearance: ShannonAppIconAppearance {
        colorScheme == .dark ? .dark : .light
    }

    var appearanceChoice: ShannonAppIconChoice {
        iconAppearance.choice
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

    var previewImage: Image {
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
