import SwiftUI

public struct ShannonConnectionView: View {
    @Bindable private var model: ShannonConnectionModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var devicePendingRevocation: ShannonConnectedDevice?

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

                        VStack(alignment: .leading, spacing: M3Spacing.medium) {
                            HStack {
                                Label("接続端末", systemImage: "laptopcomputer.and.iphone")
                                    .font(.title3.weight(.semibold))
                                Spacer()
                                if model.isLoadingDevices {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Button("再読込") { Task { await model.loadConnectedDevices() } }
                                        .buttonStyle(.borderless)
                                }
                            }
                            if model.connectedDevices.isEmpty && !model.isLoadingDevices {
                                Text(model.deviceManagementError ?? "接続中の端末を読み込んでいます。")
                                    .font(.callout)
                                    .foregroundStyle(model.deviceManagementError == nil ? palette.onSurfaceVariant : palette.error)
                            } else {
                                ForEach(model.connectedDevices) { device in
                                    Divider()
                                    connectedDeviceRow(device, palette: palette)
                                }
                                if let error = model.deviceManagementError {
                                    Text(error).font(.caption).foregroundStyle(palette.error)
                                }
                            }
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
        .task(id: model.isConnected) {
            if model.isConnected { await model.loadConnectedDevices() }
        }
        .confirmationDialog(
            "この端末の接続を解除しますか？",
            isPresented: Binding(
                get: { devicePendingRevocation != nil },
                set: { if !$0 { devicePendingRevocation = nil } }
            ),
            titleVisibility: .visible,
            presenting: devicePendingRevocation
        ) { device in
            Button("\(device.displayName)を解除", role: .destructive) {
                Task { await model.revokeConnectedDevice(device) }
            }
            Button("キャンセル", role: .cancel) {}
        } message: { _ in
            Text("この端末では、もう一度接続するまで会話・記憶・通知を利用できなくなります。")
        }
    }

    @ViewBuilder
    private func connectedDeviceRow(_ device: ShannonConnectedDevice, palette: M3Palette) -> some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: device.isCurrent ? "checkmark.circle.fill" : "desktopcomputer")
                .foregroundStyle(device.isCurrent ? palette.success : palette.onSurfaceVariant)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.displayName).font(.body.weight(.medium))
                Text(device.isCurrent ? "この端末" : lastUsedLabel(device.lastUsedAt))
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()
            if !device.isCurrent {
                Button(role: .destructive) {
                    devicePendingRevocation = device
                } label: {
                    if model.revokingDeviceIDs.contains(device.id) {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("解除")
                    }
                }
                .disabled(model.revokingDeviceIDs.contains(device.id))
            }
        }
    }

    private func lastUsedLabel(_ value: String?) -> String {
        guard let value, let date = try? Date(value, strategy: .iso8601) else { return "利用履歴なし" }
        return "最終利用 " + date.formatted(.relative(presentation: .named))
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
        case .connected: palette.success
        case .failed: palette.error
        default: palette.primary
        }
    }

    private func verificationColor(_ palette: M3Palette) -> Color {
        switch model.verificationStatus {
        case .verified: palette.success
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
