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

    func settingsSheetContent(_ palette: M3Palette) -> some View {
        ZStack(alignment: .top) {
            palette.surface
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.large) {
                    Text("設定")
                        .font(.largeTitle.bold())
                        .padding(.bottom, M3Spacing.small)

                    Button { showsStateDetails = true } label: {
                        ShannonSettingsRow(
                            title: "シャノンの状態",
                            detail: model.state == nil
                                ? model.currentExpression.japaneseName
                                : "\(model.currentExpression.japaneseName)・v\(model.state?.version ?? 0)",
                            symbol: "waveform.path.ecg"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsAppIconSettings = true } label: {
                        ShannonSettingsRow(
                            title: "アプリアイコン",
                            detail: "\(appIconModel.mode.japaneseName)・\(appIconModel.activeTitle)",
                            symbol: "app.dashed"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsAppearanceSettings = true } label: {
                        ShannonSettingsRow(
                            title: "外観",
                            detail: savedAppearanceMode.japaneseName,
                            symbol: savedAppearanceMode.symbolName
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsTestFlightDelivery = true } label: {
                        ShannonSettingsRow(
                            title: "アプリの更新",
                            detail: "TestFlightの配信状況と履歴",
                            symbol: "arrow.down.app"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsVoiceIdentity = true } label: {
                        ShannonSettingsRow(
                            title: "シャノンの声",
                            detail: voiceIdentityModel.summary,
                            symbol: "speaker.wave.2"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsWorldSubscriptions = true } label: {
                        ShannonSettingsRow(
                            title: "情報源",
                            detail: worldSubscriptionModel.summary,
                            symbol: "newspaper"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { showsVoiceDiagnostics = true } label: {
                        ShannonSettingsRow(
                            title: "音声診断",
                            detail: "クラッシュ直前の処理を確認・コピー",
                            symbol: "waveform.badge.magnifyingglass"
                        )
                    }
                    .buttonStyle(.plain)

                    if let connectionModel {
                        Button { showsConnectionDetails = true } label: {
                            ShannonSettingsRow(
                                title: "接続",
                                detail: connectionModel.statusLabel,
                                symbol: "link"
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.top, ShannonWorkspaceChrome.contentTopInset + 64)
                .padding(.bottom, 88)
            }
            .scrollIndicators(.hidden)
            .ignoresSafeArea(.container, edges: [.top, .bottom])

            ShannonTopReadabilityGradient(palette: palette)

            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ShannonBottomReadabilityGradient(palette: palette)
                    .ignoresSafeArea(.container, edges: .bottom)
            }
            .allowsHitTesting(false)

            HStack {
                Button { showsSettings = false } label: {
                    Image(systemName: "chevron.backward")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(palette.onSurface)
                        .frame(width: 48, height: 48)
                        .background(.ultraThinMaterial, in: Circle())
                        .overlay {
                            Circle().stroke(palette.outlineVariant.opacity(0.6), lineWidth: 0.7)
                        }
                        .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.10), radius: 9, y: 3)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("設定を閉じる")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, M3Spacing.large)
            .padding(.top, M3Spacing.extraSmall)
        }
        .foregroundStyle(palette.onSurface)
        .sheet(isPresented: $showsStateDetails) {
            ShannonStateSheet(state: model.state, expression: model.currentExpression)
        }
        .sheet(isPresented: $showsConnectionDetails) {
            if let connectionModel {
                ShannonConnectionView(model: connectionModel)
            }
        }
        .sheet(isPresented: $showsAppIconSettings) {
            ShannonAppIconSettingsView(
                model: appIconModel,
                expression: model.currentExpression
            )
        }
        .sheet(isPresented: $showsAppearanceSettings) {
            ShannonAppearanceSettingsView(appearanceModeRawValue: $appearanceModeRawValue)
        }
        .sheet(isPresented: $showsTestFlightDelivery) {
            ShannonTestFlightDeliveryView(model: testFlightDeliveryModel)
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
}
