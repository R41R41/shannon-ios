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
                Section {
                    settingsProfileRow(palette)
                }

                adminSection(palette)

                Section("見た目") {
                    settingsValueButton(
                        title: "外観",
                        value: ShannonSettingsSummary.appearanceLabel(savedAppearanceMode),
                        symbol: savedAppearanceMode.symbolName,
                        palette: palette
                    ) { showsAppearanceSettings = true }
                    settingsValueButton(
                        title: "アプリアイコン",
                        value: ShannonSettingsSummary.appIconLabel(appIconModel.activeChoice),
                        symbol: "app.dashed",
                        palette: palette
                    ) { showsAppIconSettings = true }
                    Picker(selection: $chatAvatarStyleRawValue) {
                        ForEach(ShannonChatAvatarStyle.allCases, id: \.rawValue) { style in
                            Text(style.japaneseName).tag(style.rawValue)
                        }
                    } label: {
                        settingsLabel("アバター", symbol: "person.crop.circle", palette: palette)
                    }
                    .accessibilityHint("チャットでシャノンの返答横に表示するアイコンを切り替えます。ホーム画面のアプリアイコンは変わりません")
                }

                Section {
                    LabeledContent {
                        Text(settingsVoiceLabel)
                            .foregroundStyle(palette.textSecondary)
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("声")
                                Text("次の通話から反映")
                                    .font(.footnote)
                                    .foregroundStyle(palette.textSecondary)
                            }
                        } icon: {
                            Image(systemName: "speaker.wave.2").foregroundStyle(palette.action)
                        }
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .accessibilityElement(children: .combine)
                    Picker(selection: $speechProviderRawValue) {
                        ForEach(ShannonSpeechProvider.allCases) { provider in
                            Text(provider.japaneseName).tag(provider.rawValue)
                        }
                    } label: {
                        settingsLabel("読み上げ", symbol: "waveform", palette: palette)
                    }
                    .accessibilityHint("Geminiで作った声とElevenLabsのShannonクローンを切り替えます。次に開始する音声会話から適用します")
                } header: {
                    Text("声と会話")
                } footer: {
                    Text("声と読み上げの変更は、通話中の会話を変えず次の通話から反映されます。")
                }

                ShannonFigureSettingsSection(showInTalk: showFigureInTalk)

                ShannonCalendarSharingSettingsSection()

                ShannonAppLookSettingsSection()

                ShannonPrivateListeningSettingsSection()

#if os(iOS)
                ShannonIncomingCallSettingsSection()
#endif

                // 配信 and 診断 are in 管理 at the top; 「接続と詳細」 is no more (decision 2026-10-03).
                Section {
                    if let connectionModel {
                        settingsValueButton(
                            title: "接続",
                            value: ShannonSettingsSummary.connectionLabel(connectionModel.status),
                            symbol: "link",
                            palette: palette
                        ) { showsConnectionDetails = true }
                    }
                    settingsValueButton(
                        title: "情報源",
                        value: worldSubscriptionModel.summary,
                        symbol: "newspaper",
                        palette: palette
                    ) { showsWorldSubscriptions = true }
                }
            }
            .navigationDestination(isPresented: $settingsShowsOps) { adminOpsPage }
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
            ShannonStateSheet(state: model.state, face: model.presentFace)
        }
        // 設定 › 接続 is this device's connection; 管理 › 接続中の端末 is the list of devices.
        .sheet(isPresented: $showsConnectionDetails) {
            if let connectionModel {
                ShannonConnectionView(model: connectionModel, part: .connection)
            }
        }
        .sheet(isPresented: $showsConnectedDevices) {
            if let connectionModel {
                ShannonConnectionView(model: connectionModel, part: .devices)
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
        .sheet(isPresented: $showsWorldSubscriptions) {
            ShannonWorldSubscriptionView(model: worldSubscriptionModel)
        }
    }

    var settingsSpeechProvider: ShannonSpeechProvider {
        ShannonSpeechProvider(rawValue: speechProviderRawValue) ?? .gemini
    }

    var settingsVoiceLabel: String {
#if os(iOS)
        ShannonSettingsSummary.voiceLabel(
            provider: settingsSpeechProvider,
            lastSessionProvider: geminiLiveVoiceModel.speechProvider,
            lastSessionVoice: geminiLiveVoiceModel.voice
        )
#else
        ShannonSettingsSummary.voiceLabel(
            provider: settingsSpeechProvider,
            lastSessionProvider: settingsSpeechProvider,
            lastSessionVoice: ""
        )
#endif
    }

    /// Shannon's profile: current avatar, name, voice and provider. Opens the
    /// existing state details. No audition button: the only preview endpoint
    /// belonged to the retired realtime voice identity.
    func settingsProfileRow(_ palette: ShannonPalette) -> some View {
        Button {
            showsStateDetails = true
        } label: {
            HStack(spacing: ShannonSpacing.medium) {
                ShannonChatAvatarView(expression: model.presentFace.expression, size: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text("シャノン")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                    Text(ShannonSettingsSummary.profileSubtitle(
                        voice: settingsVoiceLabel,
                        provider: settingsSpeechProvider
                    ))
                    .font(.subheadline)
                    .foregroundStyle(palette.textSecondary)
                    Text("いま：\(model.presentFace.japaneseName)")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                }
                Spacer(minLength: ShannonSpacing.small)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
            .padding(.vertical, ShannonSpacing.extraSmall)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("シャノンの状態を表示します")
        .accessibilityIdentifier("settings-shannon-profile")
    }

    func settingsValueButton(
        title: String,
        value: String,
        symbol: String,
        palette: ShannonPalette,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            LabeledContent {
                HStack(spacing: ShannonSpacing.small) {
                    Text(value)
                        .foregroundStyle(palette.textSecondary)
                        .multilineTextAlignment(.trailing)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityHidden(true)
                }
            } label: {
                settingsLabel(title, symbol: symbol, palette: palette)
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }

    func settingsLabel(_ title: String, symbol: String, palette: ShannonPalette) -> some View {
        Label {
            Text(title).foregroundStyle(palette.textPrimary)
        } icon: {
            Image(systemName: symbol).foregroundStyle(palette.action)
        }
    }
}
