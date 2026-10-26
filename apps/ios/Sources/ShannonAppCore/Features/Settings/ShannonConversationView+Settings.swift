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
            // Plan A (owner's choice 2026-10-26): by what he wants to do. シャノン, 声と耳 (with 声を出す場面), 見る・知る,
            // このアプリ, and 管理 last in one row. iPhone and Mac have the same parts in the same order.
            List {
                Section {
                    settingsProfileRow(palette)
                    ShannonPersonaPresetPicker(activeProvider: geminiLiveVoiceModel.phase.isCallActive ? geminiLiveVoiceModel.speechProvider : nil)
                    ShannonFigureSettingsRows(.figure, showInTalk: showFigureInTalk)
                    Picker(selection: ShannonPersonaPreset.avatarSelection($chatAvatarStyleRawValue)) {
                        ForEach(ShannonChatAvatarStyle.allCases, id: \.rawValue) { style in
                            Text(style.japaneseName).tag(style.rawValue)
                        }
                    } label: {
                        settingsLabel(ShannonGeneratedStrings.settingsChatIcon, symbol: "person.crop.circle", palette: palette)
                    }
                    .accessibilityHint("チャットでシャノンの返答横に表示するアイコンを切り替えます。ホーム画面のアプリアイコンは変わりません")
                } header: {
                    Text(ShannonGeneratedStrings.settingsGroupShannon)
                } footer: {
                    ShannonFigureSettingsFooter()
                }

                Section {
                    ShannonVoiceEarSettingsRows()
                    Picker(selection: ShannonPersonaPreset.voiceSelection($speechProviderRawValue)) {
                        ForEach(ShannonSpeechProvider.allCases) { provider in
                            Text(provider.japaneseName).tag(provider.rawValue)
                        }
                    } label: {
                        settingsLabel(ShannonGeneratedStrings.settingsVoiceKind, symbol: "waveform", palette: palette)
                    }
                    .accessibilityHint("Geminiで作った声とElevenLabsのShannonクローンを切り替えます。次に開始する音声会話から適用します")
                } header: {
                    Text(ShannonGeneratedStrings.settingsGroupVoiceEar)
                } footer: {
                    Text(ShannonGeneratedStrings.settingsGroupVoiceEarFooter)
                }

                Section {
                    ShannonFigureSettingsRows(.replyMode)
                    ShannonPrivateListeningSettingsRows(.speaking)
                } header: {
                    Text(ShannonGeneratedStrings.settingsGroupVoiceScenes)
                } footer: {
                    Text(ShannonBodyCopy.replyModeExplanation + "\n\n" + ShannonPrivateListeningCopy.speakingExplanation)
                }

#if os(iOS)
                ShannonIncomingCallSettingsSection(header: nil)
#endif

                ShannonAppLookSettingsSection(header: ShannonGeneratedStrings.settingsGroupSenses)
                Section {
                    ShannonFigureSettingsRows(.touch)
                }
                ShannonCalendarSharingSettingsSection(header: nil)
                Section {
                    settingsValueButton(
                        title: "情報源",
                        value: worldSubscriptionModel.summary,
                        symbol: "newspaper",
                        palette: palette
                    ) { showsWorldSubscriptions = true }
                }

                Section {
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
                    NavigationLink {
                        settingsEarphonesPage(palette)
                    } label: {
                        settingsLabel(ShannonPrivateListeningCopy.sectionTitle, symbol: "headphones", palette: palette)
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .accessibilityIdentifier("settings-earphones")
                    if let connectionModel {
                        settingsValueButton(
                            title: ShannonGeneratedStrings.settingsConnection,
                            value: ShannonSettingsSummary.connectionLabel(connectionModel.status),
                            symbol: "link",
                            palette: palette
                        ) { showsConnectionDetails = true }
                    }
                } header: {
                    Text(ShannonGeneratedStrings.settingsGroupThisApp)
                }

                Section {
                    NavigationLink {
                        settingsAdminPage(palette)
                    } label: {
                        LabeledContent {
                            Text(ShannonGeneratedStrings.settingsGroupAdminSummary)
                                .foregroundStyle(palette.textSecondary)
                                .lineLimit(1)
                        } label: {
                            settingsLabel(ShannonGeneratedStrings.navAdmin, symbol: "server.rack", palette: palette)
                        }
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .accessibilityIdentifier("settings-admin")
                }
            }
            .navigationDestination(isPresented: $settingsShowsOps) { adminOpsPage }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle(ShannonGeneratedStrings.navSettings)
#if os(iOS)
            .navigationBarTitleDisplayMode(.large)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(ShannonGeneratedStrings.commonClose) { showsSettings = false }
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
        ShannonPersonaPreset.provider(legacy: speechProviderRawValue, preset: presetRawValue)
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
                ShannonChatAvatarView(face: model.presentFace, size: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.appName)
                        .font(.shannon(.title3).weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                    Text(ShannonSettingsSummary.profileSubtitle(
                        voice: settingsVoiceLabel,
                        provider: settingsSpeechProvider
                    ))
                    .font(.shannon(.subheadline))
                    .foregroundStyle(palette.textSecondary)
                    Text("いま：\(model.presentFace.japaneseName)")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                }
                Spacer(minLength: ShannonSpacing.small)
                Image(systemName: "chevron.right")
                    .font(.shannon(.caption).weight(.semibold))
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
                        .font(.shannon(.caption).weight(.semibold))
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
