import SwiftUI

public struct ShannonConnectionView: View {
    /// Which part of the connection a place of Settings opens. On the iPhone 設定 › 接続 is this device's
    /// connection, and 設定 › 管理 › 接続中の端末 is the list of devices (docs/product/information-architecture.md, 1).
    public enum Part: Sendable {
        /// Both, as the Mac's sheet shows them.
        case all
        /// The state, the first pairing, the check of the connection, and unpairing this device.
        case connection
        /// The connected devices, and unpairing another one.
        case devices
    }

    @Bindable private var model: ShannonConnectionModel
    private let part: Part
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var devicePendingRevocation: ShannonConnectedDevice?
    @State private var showsSelfDisconnectConfirmation = false

    public init(model: ShannonConnectionModel, part: Part = .all) {
        self.model = model
        self.part = part
    }

    private var showsConnection: Bool { part != .devices }
    private var showsDevices: Bool { part != .connection }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.extraLarge) {
                    // The list of devices alone says the state only while there is no list to show.
                    if showsConnection || !model.isConnected { connectionStatus(palette) }

                    if !model.isConnected, showsConnection {
                        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                            Label("最初の一度だけ", systemImage: "link.badge.plus")
                                .font(.title3.weight(.semibold))
                            Text("シャノン専用の接続リンクを開くと、この\(deviceNoun)は自動で結ばれます。コード入力や毎回の設定は必要ありません。")
                                .font(.callout)
                                .foregroundStyle(palette.textSecondary)
                            if case .connecting = model.status {
                                HStack(spacing: ShannonSpacing.small) {
                                    ProgressView().tint(palette.action)
                                    Text("安全に接続しています…")
                                        .font(.callout.weight(.medium))
                                }
                            }
                        }
                        .padding(ShannonSpacing.large)
                        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
                    } else if model.isConnected {
                        if showsConnection { connectionCard(palette) }
                        if showsDevices { devicesCard(palette) }
                    }

                    if showsConnection { secretCard(palette) }
                }
                .padding(ShannonSpacing.extraLarge)
            }
            .background(palette.canvas)
            .navigationTitle(part == .devices ? ShannonGeneratedStrings.settingsSectionDevices : "シャノンとの接続")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task(id: model.isConnected) {
            if model.isConnected, showsDevices { await model.loadConnectedDevices() }
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
        .confirmationDialog(
            "この\(deviceNoun)の接続を解除しますか？",
            isPresented: $showsSelfDisconnectConfirmation,
            titleVisibility: .visible
        ) {
            Button("接続を解除", role: .destructive) {
                Task { await model.disconnect() }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("サーバー上の端末資格と通知登録も失効します。再利用するには、もう一度接続してください。")
        }
    }

    private func connectionCard(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
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
                    .foregroundStyle(palette.danger)
            }
            Divider()
            Button(role: .destructive) {
                showsSelfDisconnectConfirmation = true
            } label: {
                Label("この\(deviceNoun)の接続を解除", systemImage: "link.badge.minus")
                    .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
            }
            .buttonStyle(.bordered)
        }
        .padding(ShannonSpacing.large)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
    }

    private func devicesCard(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
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
                    .foregroundStyle(model.deviceManagementError == nil ? palette.textSecondary : palette.danger)
            } else {
                ForEach(model.connectedDevices) { device in
                    Divider()
                    connectedDeviceRow(device, palette: palette)
                }
                if let error = model.deviceManagementError {
                    Text(error).font(.caption).foregroundStyle(palette.danger)
                }
            }
        }
        .padding(ShannonSpacing.large)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
    }

    private func secretCard(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label("秘密は\(deviceNoun)の中に", systemImage: "lock.shield")
                .font(.title3.weight(.semibold))
            Text("端末トークンは、この\(deviceNoun)のKeychainへ保存します。OpenAI APIキーや接続コードは保存しません。")
                .font(.callout)
                .foregroundStyle(palette.textSecondary)
            Text(model.baseURL.host ?? model.baseURL.absoluteString)
                .font(.caption.monospaced())
                .foregroundStyle(palette.action)
        }
        .padding(ShannonSpacing.large)
        .background(palette.userMessage, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
    }

    @ViewBuilder
    private func connectedDeviceRow(_ device: ShannonConnectedDevice, palette: ShannonPalette) -> some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: device.isCurrent ? "checkmark.circle.fill" : "desktopcomputer")
                .foregroundStyle(device.isCurrent ? palette.success : palette.textSecondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.displayName).font(.body.weight(.medium))
                Text(device.isCurrent ? "この端末" : lastUsedLabel(device.lastUsedAt))
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
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
    private func connectionStatus(_ palette: ShannonPalette) -> some View {
        HStack(spacing: ShannonSpacing.large) {
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
                        .foregroundStyle(palette.danger)
                } else {
                    Text(model.isConnected ? "会話と記憶を安全に同期できます" : disconnectedDescription)
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
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

    private func statusColor(_ palette: ShannonPalette) -> Color {
        switch model.status {
        case .connected: palette.success
        case .failed: palette.danger
        default: palette.action
        }
    }

    private func verificationColor(_ palette: ShannonPalette) -> Color {
        switch model.verificationStatus {
        case .verified: palette.success
        case .failed: palette.danger
        default: palette.textSecondary
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
