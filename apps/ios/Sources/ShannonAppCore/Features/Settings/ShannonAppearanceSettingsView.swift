import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonAppearanceSettingsView: View {
    @Binding var appearanceModeRawValue: String
    @Environment(\.dismiss) var dismiss
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            VStack(spacing: M3Spacing.small) {
                ForEach(ShannonAppearanceMode.allCases) { mode in
                    Button {
                        appearanceModeRawValue = mode.rawValue
                    } label: {
                        HStack(spacing: M3Spacing.medium) {
                            Image(systemName: mode.symbolName)
                                .font(.system(size: 20, weight: .medium))
                                .foregroundStyle(palette.primary)
                                .frame(width: 44, height: 44)
                                .background(palette.secondaryContainer, in: Circle())
                            Text(mode.japaneseName)
                                .font(.body.weight(.medium))
                                .foregroundStyle(palette.onSurface)
                            Spacer()
                            if appearanceModeRawValue == mode.rawValue {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(palette.primary)
                            }
                        }
                        .padding(.horizontal, M3Spacing.large)
                        .frame(minHeight: 64)
                        .background(
                            appearanceModeRawValue == mode.rawValue
                                ? palette.primaryContainer.opacity(0.55)
                                : Color.clear,
                            in: RoundedRectangle(cornerRadius: M3Shape.large)
                        )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(M3Spacing.large)
            .background(palette.surface)
            .navigationTitle("外観")
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
}
