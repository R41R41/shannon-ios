import SwiftUI

public struct ShannonConnectionView: View {
    @Bindable private var model: ShannonConnectionModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    public init(model: ShannonConnectionModel) {
        self.model = model
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                    connectionStatus(palette)

                    if !model.isConnected {
                        VStack(alignment: .leading, spacing: M3Spacing.medium) {
                            Text("接続コード")
                                .font(.title3.weight(.semibold))
                            Text("Azure VMで発行した12桁のコードを入力します。コードは30分間、一度だけ使えます。")
                                .font(.callout)
                                .foregroundStyle(palette.onSurfaceVariant)

                            TextField("ABCD-EF12-3456", text: $model.pairingCode)
                                .font(.title3.monospaced().weight(.semibold))
                                .textFieldStyle(.plain)
                                .autocorrectionDisabled()
                                .padding(.horizontal, M3Spacing.large)
                                .frame(minHeight: 56)
                                .background(
                                    palette.surfaceContainerHigh,
                                    in: RoundedRectangle(cornerRadius: M3Shape.medium, style: .continuous)
                                )
                                .overlay {
                                    RoundedRectangle(cornerRadius: M3Shape.medium, style: .continuous)
                                        .stroke(palette.outline, lineWidth: 1)
                                }
                                .accessibilityLabel("12桁の接続コード")

                            Button {
                                Task { await model.pair() }
                            } label: {
                                HStack(spacing: M3Spacing.small) {
                                    if case .connecting = model.status {
                                        ProgressView().tint(palette.onPrimary)
                                    } else {
                                        Image(systemName: "link")
                                    }
                                    Text("シャノンと接続")
                                }
                                .font(.headline)
                                .foregroundStyle(palette.onPrimary)
                                .frame(maxWidth: .infinity, minHeight: 52)
                                .background(palette.primary, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .disabled(model.pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isConnecting)
                        }
                        .padding(M3Spacing.large)
                        .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                    } else {
                        Button(role: .destructive) { model.disconnect() } label: {
                            Label("このiPhoneの接続を解除", systemImage: "link.badge.minus")
                                .frame(maxWidth: .infinity, minHeight: M3TouchTarget.minimum)
                        }
                        .buttonStyle(.bordered)
                    }

                    VStack(alignment: .leading, spacing: M3Spacing.medium) {
                        Label("秘密はiPhoneの中に", systemImage: "lock.shield")
                            .font(.title3.weight(.semibold))
                        Text("端末トークンは、このiPhoneをロック解除している間だけ読めるKeychainへ保存します。OpenAI APIキーや接続コードは保存しません。")
                            .font(.callout)
                            .foregroundStyle(palette.onSurfaceVariant)
                        Text(model.baseURL.host ?? model.baseURL.absoluteString)
                            .font(.caption.monospaced())
                            .foregroundStyle(palette.primary)
                    }
                    .padding(M3Spacing.large)
                    .background(palette.primaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                }
                .padding(M3Spacing.extraLarge)
            }
            .background(palette.surface)
            .navigationTitle("シャノンとの接続")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var isConnecting: Bool {
        if case .connecting = model.status { return true }
        return false
    }

    @ViewBuilder
    private func connectionStatus(_ palette: M3Palette) -> some View {
        HStack(spacing: M3Spacing.large) {
            Image(systemName: statusSymbol)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(statusColor(palette))
                .frame(width: 56, height: 56)
                .background(statusColor(palette).opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(model.statusLabel)
                    .font(.title2.weight(.semibold))
                if case .failed(let message) = model.status {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(palette.error)
                } else {
                    Text(model.isConnected ? "会話と記憶を安全に同期できます" : "接続すると、Macなしで話せます")
                        .font(.callout)
                        .foregroundStyle(palette.onSurfaceVariant)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var statusSymbol: String {
        switch model.status {
        case .disconnected: "link.badge.plus"
        case .connecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .connected: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private func statusColor(_ palette: M3Palette) -> Color {
        switch model.status {
        case .connected: Color(hex: 0x2E7D32)
        case .failed: palette.error
        default: palette.primary
        }
    }
}
