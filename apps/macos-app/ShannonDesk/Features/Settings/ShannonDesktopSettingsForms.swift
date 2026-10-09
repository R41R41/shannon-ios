import AppKit
import ShannonAppCore
import SwiftUI

/// The parts of 設定 that are a form of their own on the right.
extension ShannonDesktopRootView {
    var settingsForm: some View {
        Form {
            switch settingsPage {
            case .figure:
                // 「トークで姿を見る」 opens the 「すがた」 panel beside Talk (A15).
                ShannonFigureSettingsSection {
                    selectDestination(.talk)
                    showAuxiliaryPanel(.figure)
                }
                // Her desktop body (A17): her window, on top, her size (also in the menu bar item).
                ShannonDesktopBodySettingsSection()
                // 配信用の出力（OBS, A18 S5): her figure for an OBS browser source, off by default (also in the menu bar item).
                ShannonStreamOutputSettingsSection()
            case .camera:
                ShannonAppLookSettingsSection()
                // Her desktop body's one look at the room: its own switch, off by default (Syzygy ADR-0002).
                ShannonDesktopBodyCameraSection()
            case .earphones:
                ShannonPrivateListeningSettingsSection()
            case .voice:
                Section { ShannonPersonaPresetPicker(activeProvider: voiceCall.session.phase.isCallActive ? voiceCall.session.speechProvider : nil) }
                // The voice of a voice conversation, of her words through the earphones and of a touch (A16), as on the iPhone.
                Section {
                    Picker(ShannonGeneratedStrings.voiceMacProvider, selection: ShannonPersonaPreset.voiceSelection($speechProviderRawValue)) {
                        ForEach(ShannonSpeechProvider.allCases) { provider in
                            Text(provider.japaneseName).tag(provider.rawValue)
                        }
                    }
                    .help(ShannonGeneratedStrings.voiceMacProviderHint)
                    .accessibilityHint(ShannonGeneratedStrings.voiceMacProviderHint)
                    .accessibilityIdentifier("settings-voice-provider")
                    Text(ShannonGeneratedStrings.voiceMacProviderNote)
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                } header: {
                    Text(ShannonGeneratedStrings.settingsSectionVoice)
                }
            case .modelMode:
                ShannonModelModeSettingsSection(conversation: conversation, connected: connection.isConnected)
            case .calendar:
                ShannonCalendarSharingSettingsSection()
            case .folder:
                // Her folder on this Mac (A18 S2, S3): chosen, paused, checked and stopped here; she lists, searches, reads and changes it.
                ShannonFolderHostSettingsSection()
                // Opening at login (on by default while a folder is chosen) and retiring the Electron app (A18 S4).
                ShannonFolderHostLoginSection()
            case .appearance:
                appearanceSections
            case .ops, .devices, .delivery, .diagnostics, .connection, .sources:
                EmptyView()
            }
        }
        .formStyle(.grouped)
        .padding(ShannonDesktopSpacing.large)
    }

    @ViewBuilder
    private var appearanceSections: some View {
        Section("外観") {
            Picker("表示", selection: $appearanceRawValue) {
                ForEach(ShannonAppearanceMode.allCases) { mode in
                    Label(mode.japaneseName, systemImage: mode.symbolName)
                        .tag(mode.rawValue)
                }
            }
            .pickerStyle(.segmented)

            LabeledContent("アプリアイコン", value: appIcon.activeTitle)
            Button("アプリアイコンを選ぶ") {
                showsAppIconSettings = true
            }
            Picker("アバター", selection: ShannonPersonaPreset.avatarSelection($chatAvatarStyleRawValue)) {
                ForEach(ShannonChatAvatarStyle.allCases, id: \.rawValue) { style in
                    Text(style.japaneseName).tag(style.rawValue)
                }
            }
            .help("トークでシャノンの返答の横に出すアイコンを切り替えます。Dock のアイコンは変わりません")
        }

        Section("Shannon Desk") {
            LabeledContent("バージョン", value: appVersionDescription)
            LabeledContent("会話と記憶", value: "iPhoneと共通")
            LabeledContent("作業の正本", value: "Azureの永続タスク")
            Text("水色は操作面を染めず、シャノンの存在・感情・注意が必要な場所にだけ使います。")
                .foregroundStyle(.secondary)
        }
    }

    var appVersionDescription: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(version) (\(build))"
    }
}
