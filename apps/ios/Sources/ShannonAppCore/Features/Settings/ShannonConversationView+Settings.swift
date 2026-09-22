import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    var settingsSheet: some View {
        ShannonEnvironmentPaletteReader { palette in
            settingsSheetContent(palette)
        }
        .environment(\.colorScheme, resolvedColorScheme)
    }

    func settingsSheetContent(_ palette: ShannonPalette) -> some View {
        NavigationStack {
            List {
                Section("Shannon") {
                    settingsButton(
                        title: "シャノンの状態",
                        detail: model.state == nil
                            ? model.currentExpression.japaneseName
                            : "\(model.currentExpression.japaneseName)・v\(model.state?.version ?? 0)",
                        symbol: "waveform.path.ecg"
                    ) { showsStateDetails = true }
                }

                Section("表示") {
                    settingsButton(
                        title: "アプリアイコン",
                        detail: appIconModel.activeTitle,
                        symbol: "app.dashed"
                    ) { showsAppIconSettings = true }
                    settingsButton(
                        title: "外観",
                        detail: savedAppearanceMode.japaneseName,
                        symbol: savedAppearanceMode.symbolName
                    ) { showsAppearanceSettings = true }
                    Picker("チャットのシャノンのアイコン", selection: $chatAvatarStyleRawValue) {
                        ForEach(ShannonChatAvatarStyle.allCases, id: \.rawValue) { style in
                            Text(style.japaneseName).tag(style.rawValue)
                        }
                    }
                    .accessibilityHint("シャノンの返答横に表示するアイコンを切り替えます")
                }

                Section("音声と情報") {
                    settingsButton(
                        title: "シャノンの声",
                        detail: voiceIdentityModel.summary,
                        symbol: "speaker.wave.2"
                    ) { showsVoiceIdentity = true }
                    settingsButton(
                        title: "情報源",
                        detail: worldSubscriptionModel.summary,
                        symbol: "newspaper"
                    ) { showsWorldSubscriptions = true }
                }

                Section("接続と配信") {
                    if let connectionModel {
                        settingsButton(
                            title: "接続",
                            detail: connectionModel.statusLabel,
                            symbol: "link"
                        ) { showsConnectionDetails = true }
                    }
                    settingsButton(
                        title: "アプリの更新",
                        detail: "TestFlightの配信状況と履歴",
                        symbol: "arrow.down.app"
                    ) { showsTestFlightDelivery = true }
                }

                Section("詳細") {
                    settingsButton(
                        title: "音声診断",
                        detail: "クラッシュ直前の処理を確認・コピー",
                        symbol: "waveform.badge.magnifyingglass"
                    ) { showsVoiceDiagnostics = true }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle("設定")
#if os(iOS)
            .navigationBarTitleDisplayMode(.large)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { showsSettings = false }
                }
            }
        }
        .foregroundStyle(palette.textPrimary)
        .sheet(isPresented: $showsStateDetails) {
            ShannonStateSheet(state: model.state, expression: model.currentExpression)
        }
        .sheet(isPresented: $showsConnectionDetails) {
            if let connectionModel {
                ShannonConnectionView(model: connectionModel)
            }
        }
        .sheet(isPresented: $showsAppIconSettings) {
            ShannonAppIconSettingsView(model: appIconModel)
        }
        .sheet(isPresented: $showsAppearanceSettings) {
            ShannonAppearanceSettingsView(appearanceModeRawValue: $appearanceModeRawValue)
        }
        .sheet(isPresented: $showsTestFlightDelivery) {
            ShannonTestFlightDeliveryView(model: testFlightDeliveryModel) { target in
                let taskID = model.proposeAppleRelease(target)
                showsTestFlightDelivery = false
                showsSettings = false
                selectedPage = .work
                openAgentTask(taskID)
            }
        }
        .sheet(isPresented: $showsVoiceDiagnostics) {
            ShannonVoiceDiagnosticsView()
        }
        .sheet(isPresented: $showsVoiceIdentity) {
            ShannonVoiceIdentityView(model: voiceIdentityModel)
        }
        .sheet(isPresented: $showsWorldSubscriptions) {
            ShannonWorldSubscriptionView(model: worldSubscriptionModel)
        }
    }

    func settingsButton(
        title: String,
        detail: String,
        symbol: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ShannonSettingsRow(title: title, detail: detail, symbol: symbol)
        }
        .buttonStyle(.plain)
    }
}
