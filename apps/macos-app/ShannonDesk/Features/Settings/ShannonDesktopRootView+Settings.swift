import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

extension ShannonDesktopRootView {
    var settingsView: some View {
        Form {
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
            }

            Section("接続") {
                LabeledContent("状態", value: connection.statusLabel)
                LabeledContent("通信", value: connection.verificationLabel)
                Button(connection.isConnected ? "接続情報を見る" : "シャノンへ接続") {
                    showsConnection = true
                }
            }

            Section("シャノンの声") {
                LabeledContent("方式", value: "Gemini")
                Text("声はShannonサーバー側のGemini設定から一貫して適用されます。")
                    .foregroundStyle(.secondary)
            }

            Section("情報源") {
                LabeledContent("状態", value: worldSubscriptions.summary)
                Button("購読候補と試読を見る") {
                    showsWorldSubscriptions = true
                }
                if let errorMessage = worldSubscriptions.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(Color.shannonDanger)
                }
            }

            ShannonFormSettingsSection(openBody: { showsBody = true }, showsTouchSwitch: false)

            ShannonCalendarSharingSettingsSection()

            ShannonAppLookSettingsSection()

            ShannonPrivateListeningSettingsSection()

            ShannonAutonomySettingsSection(model: memory.autonomy)

            Section("Shannon Desk") {
                LabeledContent("バージョン", value: appVersionDescription)
                LabeledContent("会話と記憶", value: "iPhoneと共通")
                LabeledContent("作業の正本", value: "Azureの永続タスク")
                Text("水色は操作面を染めず、シャノンの存在・感情・注意が必要な場所にだけ使います。")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(24)
        .navigationTitle("設定")
        .sheet(isPresented: $showsBody) {
            NavigationStack { ShannonBodyScreen(memory: memory) }
                .frame(minWidth: 460, minHeight: 720)
        }
        .task { await worldSubscriptions.reload() }
    }

    var appVersionDescription: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(version) (\(build))"
    }

}
