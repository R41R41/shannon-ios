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
            }

            Section("接続") {
                LabeledContent("状態", value: connection.statusLabel)
                LabeledContent("通信", value: connection.verificationLabel)
                Button(connection.isConnected ? "接続情報を見る" : "シャノンへ接続") {
                    showsConnection = true
                }
            }

            Section("シャノンの声") {
                Picker("声", selection: voiceIdentitySelection) {
                    Text("シャノンに任せる").tag("automatic")
                    ForEach(voiceIdentity.response.candidates) { candidate in
                        Text(candidate.name).tag(candidate.id)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(voiceIdentity.savingVoiceID != nil)

                HStack {
                    ForEach(voiceIdentity.response.candidates) { candidate in
                        Button {
                            Task { await voiceIdentity.togglePreview(candidate) }
                        } label: {
                            Label(
                                candidate.name,
                                systemImage: voiceIdentity.previewingVoiceID == candidate.id
                                    ? "stop.fill" : "play.fill"
                            )
                        }
                    }
                }
                Text("変更は次に始める音声会話から反映され、iPhoneと共有されます。")
                    .foregroundStyle(.secondary)
                if let errorMessage = voiceIdentity.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }

            Section("情報源") {
                LabeledContent("状態", value: worldSubscriptions.summary)
                Button("購読候補と試読を見る") {
                    showsWorldSubscriptions = true
                }
                if let errorMessage = worldSubscriptions.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }

            Section("Shannon Desk") {
                LabeledContent("会話と記憶", value: "iPhoneと共通")
                LabeledContent("作業の正本", value: "Azureの永続タスク")
                Text("水色は操作面を染めず、シャノンの存在・感情・注意が必要な場所にだけ使います。")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(24)
        .navigationTitle("設定")
        .task { await worldSubscriptions.reload() }
        .onDisappear { voiceIdentity.stopPreview() }
    }

    var voiceIdentitySelection: Binding<String> {
        Binding(
            get: {
                voiceIdentity.response.preference.mode == .automatic
                    ? "automatic"
                    : voiceIdentity.response.preference.selectedVoice ?? "automatic"
            },
            set: { value in
                Task {
                    if value == "automatic" {
                        await voiceIdentity.selectAutomatic()
                    } else if let candidate = voiceIdentity.response.candidates.first(where: { $0.id == value }) {
                        await voiceIdentity.select(candidate)
                    }
                }
            }
        )
    }
}
