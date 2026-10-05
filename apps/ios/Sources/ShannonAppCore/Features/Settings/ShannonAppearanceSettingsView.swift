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
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            VStack(spacing: ShannonSpacing.small) {
                ForEach(ShannonAppearanceMode.allCases) { mode in
                    Button {
                        appearanceModeRawValue = mode.rawValue
                    } label: {
                        HStack(spacing: ShannonSpacing.medium) {
                            Image(systemName: mode.symbolName)
                                .font(.system(size: 20, weight: .medium))
                                .foregroundStyle(palette.action)
                                .frame(width: 44, height: 44)
                                .background(palette.subtleSurface, in: Circle())
                            Text(mode.japaneseName)
                                .font(.shannon(.body).weight(.medium))
                                .foregroundStyle(palette.textPrimary)
                            Spacer()
                            if appearanceModeRawValue == mode.rawValue {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(palette.action)
                            }
                        }
                        .padding(.horizontal, ShannonSpacing.large)
                        .frame(minHeight: 64)
                        .background(
                            appearanceModeRawValue == mode.rawValue
                                ? palette.userMessage.opacity(0.55)
                                : Color.clear,
                            in: RoundedRectangle(cornerRadius: ShannonShape.large)
                        )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(ShannonSpacing.large)
            .background(palette.canvas)
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
