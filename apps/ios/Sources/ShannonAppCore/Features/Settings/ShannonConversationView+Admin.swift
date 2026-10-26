import SwiftUI

/// 「設定 › 管理」 (docs/product/information-architecture.md, 4): 判断モデル, 運用, 接続中の端末, 配信 and 診断, on a page of
/// their own behind the last row of Settings (plan A, 2026-10-26: what is for running her comes last). 運用 carries the
/// mark and its reason in one line while something there deserves a look; before the first report it says so.
extension ShannonConversationView {
    /// The page behind 管理.
    func settingsAdminPage(_ palette: ShannonPalette) -> some View {
        List {
            ShannonModelModeSettingsSection(scopeKey: model.scopeKey,
                client: model.client as? any ShannonModelModeServing,
                connected: connectionModel?.isConnected == true, isDesignPreview: model.isDesignPreview)
                .id(model.scopeKey)
            adminSection(palette)
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .navigationTitle(ShannonGeneratedStrings.navAdmin)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
    }

    /// The page behind このアプリ › イヤホン: what the sound comes out of, and the earphones he registered.
    func settingsEarphonesPage(_ palette: ShannonPalette) -> some View {
        List {
            Section {
                ShannonPrivateListeningSettingsRows(.earphones)
            } footer: {
                Text(ShannonPrivateListeningCopy.explanation)
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .navigationTitle(ShannonPrivateListeningCopy.sectionTitle)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
    }

    func adminSection(_ palette: ShannonPalette) -> some View {
        Section {
            if yousu.ops.isSupported {
                NavigationLink {
                    adminOpsPage
                } label: {
                    opsRow(palette)
                }
                .accessibilityElement(children: .combine)
                .accessibilityHint(ShannonGeneratedStrings.adminOpsHint)
                .accessibilityIdentifier("settings-admin-ops")
            }
            if let connectionModel {
                settingsValueButton(
                    title: ShannonGeneratedStrings.settingsSectionDevices,
                    value: connectionModel.connectedDevices.isEmpty ? "" : ShannonGeneratedStrings.adminDevicesCount(count: String(connectionModel.connectedDevices.count)),
                    symbol: "laptopcomputer.and.iphone",
                    palette: palette
                ) { showsConnectedDevices = true }
                .accessibilityHint(ShannonGeneratedStrings.adminDevicesHint)
            }
            settingsValueButton(
                title: ShannonGeneratedStrings.navDelivery,
                value: "TestFlight",
                symbol: "arrow.down.app",
                palette: palette
            ) { showsTestFlightDelivery = true }
            .accessibilityHint("アプリの更新、TestFlightの配信状況と履歴を開きます")
            settingsValueButton(
                title: ShannonGeneratedStrings.navDiagnostics,
                value: "音声",
                symbol: "waveform.badge.magnifyingglass",
                palette: palette
            ) { showsVoiceDiagnostics = true }
            .accessibilityHint("音声の処理時間を確認・コピーします")
        }
        // The number of connected devices on its row, without opening the list first.
        .task(id: connectionModel?.isConnected) {
            guard let connectionModel, connectionModel.isConnected, connectionModel.connectedDevices.isEmpty,
                  !connectionModel.isLoadingDevices else { return }
            await connectionModel.loadConnectedDevices()
        }
    }

    /// The page the 運用 row opens, inside Settings' own navigation.
    var adminOpsPage: some View {
        ShannonOpsView(model: yousu.ops)
            .navigationTitle(ShannonGeneratedStrings.opsTitle)
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
    }

    private func opsRow(_ palette: ShannonPalette) -> some View {
        let reason = yousu.ops.attentionReason()
        let detail = reason
            ?? (yousu.ops.connectionIsInvalid ? ShannonGeneratedStrings.opsConnectionInvalid : nil)
            ?? (yousu.ops.didLoad && !yousu.ops.hasReport ? ShannonGeneratedStrings.opsNotReported : nil)
        return HStack(spacing: ShannonSpacing.medium) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.opsTitle).foregroundStyle(palette.textPrimary)
                    if let detail {
                        Text(detail)
                            .font(.shannon(.footnote))
                            .foregroundStyle(reason == nil ? palette.textSecondary : palette.onAttentionTint)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } icon: {
                Image(systemName: "server.rack").foregroundStyle(palette.action)
            }
            Spacer(minLength: ShannonSpacing.small)
            if reason != nil {
                // The shape says it as well as the colour.
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(palette.attention)
                    .accessibilityLabel("確かめたいことがあります")
            }
        }
        .frame(minHeight: ShannonTouchTarget.minimum)
        .contentShape(Rectangle())
    }
}
