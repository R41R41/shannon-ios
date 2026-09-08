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
                            Label("最初の一度だけ", systemImage: "link.badge.plus")
                                .font(.title3.weight(.semibold))
                            Text("シャノン専用の接続リンクを開くと、この\(deviceNoun)は自動で結ばれます。コード入力や毎回の設定は必要ありません。")
                                .font(.callout)
                                .foregroundStyle(palette.onSurfaceVariant)
                            if case .connecting = model.status {
                                HStack(spacing: M3Spacing.small) {
                                    ProgressView().tint(palette.primary)
                                    Text("安全に接続しています…")
                                        .font(.callout.weight(.medium))
                                }
                            }
                        }
                        .padding(M3Spacing.large)
                        .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                    } else {
                        VStack(alignment: .leading, spacing: M3Spacing.medium) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("認証された通信")
                                        .font(.headline)
                                    Text(model.verificationLabel)
                                        .font(.callout)
                                        .foregroundStyle(verificationColor(palette))
                                }
                                Spacer()
                                if model.isVerifying {
                                    ProgressView().controlSize(.small)
                                }
                                Button("接続を確認") {
                                    Task { await model.verifyConnection() }
                                }
                                .disabled(model.isVerifying)
                            }
                            if case .failed(let message) = model.verificationStatus {
                                Text(message)
                                    .font(.caption)
                                    .foregroundStyle(palette.error)
                            }
                            Divider()
                            Button(role: .destructive) { model.disconnect() } label: {
                                Label("この\(deviceNoun)の接続を解除", systemImage: "link.badge.minus")
                                    .frame(maxWidth: .infinity, minHeight: M3TouchTarget.minimum)
                            }
                            .buttonStyle(.bordered)
                        }
                        .padding(M3Spacing.large)
                        .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                    }

                    VStack(alignment: .leading, spacing: M3Spacing.medium) {
                        Label("秘密は\(deviceNoun)の中に", systemImage: "lock.shield")
                            .font(.title3.weight(.semibold))
                        Text("端末トークンは、この\(deviceNoun)のKeychainへ保存します。OpenAI APIキーや接続コードは保存しません。")
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
                    Text(model.isConnected ? "会話と記憶を安全に同期できます" : disconnectedDescription)
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

    private func verificationColor(_ palette: M3Palette) -> Color {
        switch model.verificationStatus {
        case .verified: Color(hex: 0x2E7D32)
        case .failed: palette.error
        default: palette.onSurfaceVariant
        }
    }

    private var deviceNoun: String {
#if os(macOS)
        "Mac"
#else
        "iPhone"
#endif
    }

    private var disconnectedDescription: String {
#if os(macOS)
        "接続すると、iPhoneと同じシャノンへ続きます"
#else
        "接続すると、Macなしで話せます"
#endif
    }
}
