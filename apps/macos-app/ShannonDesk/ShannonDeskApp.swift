import AppKit
import ShannonAppCore
import SwiftUI

@main
struct ShannonDeskApp: App {
    @State private var conversationModel: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel
    @State private var memoryModel: ShannonMemoryModel
    @State private var voiceIdentityModel: ShannonVoiceIdentityModel
    @State private var worldSubscriptionModel: ShannonWorldSubscriptionModel
    @AppStorage(ShannonAppearanceMode.storageKey) private var appearanceRawValue = ShannonAppearanceMode.system.rawValue

    init() {
        let usesDesignPreview: Bool
#if DEBUG
        usesDesignPreview = ProcessInfo.processInfo.arguments.contains("-ShannonDesignPreview")
            || (Bundle.main.object(forInfoDictionaryKey: "ShannonDesignPreview") as? Bool == true)
#else
        usesDesignPreview = false
#endif
        let connectionStore: any ShannonConnectionStoreProtocol = usesDesignPreview
            ? ShannonDeskPreviewConnectionStore()
            : ShannonKeychainConnectionStore()
        let client = ShannonAPIClient(
            baseURL: ShannonDeskRuntimeConfiguration.apiBaseURL,
            apiToken: ShannonDeskRuntimeConfiguration.apiToken,
            connectionStore: connectionStore
        )
#if DEBUG
        _conversationModel = State(initialValue: usesDesignPreview
            ? ShannonConversationModel.designPreview()
            : ShannonConversationModel(client: client))
#else
        _conversationModel = State(initialValue: ShannonConversationModel(client: client))
#endif
        _connectionModel = State(initialValue: ShannonConnectionModel(
            baseURL: ShannonDeskRuntimeConfiguration.apiBaseURL,
            store: connectionStore,
            deviceName: { Host.current().localizedName ?? "Mac" }
        ))
        _memoryModel = State(initialValue: ShannonMemoryModel(client: client))
        _voiceIdentityModel = State(initialValue: ShannonVoiceIdentityModel(client: client))
        _worldSubscriptionModel = State(initialValue: ShannonWorldSubscriptionModel(client: client))
    }

    var body: some Scene {
        WindowGroup {
            ShannonDesktopRootView(
                conversation: conversationModel,
                connection: connectionModel,
                memory: memoryModel,
                voiceIdentity: voiceIdentityModel,
                worldSubscriptions: worldSubscriptionModel
            )
            .preferredColorScheme(preferredColorScheme)
            .onOpenURL { url in
                Task {
                    if await connectionModel.connect(using: url) {
                        await connectionModel.verifyConnection()
                    }
                }
            }
        }
        .defaultSize(width: 1220, height: 790)
        .windowResizability(.contentMinSize)
        .commands {
            ShannonDeskCommands(conversation: conversationModel)
        }

        Settings {
            ShannonDesktopSettingsScene(
                connection: connectionModel,
                appearanceRawValue: $appearanceRawValue,
                voiceIdentity: voiceIdentityModel,
                worldSubscriptions: worldSubscriptionModel
            )
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch ShannonAppearanceMode(rawValue: appearanceRawValue) ?? .system {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct ShannonDeskCommands: Commands {
    let conversation: ShannonConversationModel
    @FocusedValue(\.shannonDesktopCommandActions) private var actions

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("新しいトーク") {
                Task { await conversation.createThread(title: nil) }
                actions?.showTalk()
            }
            .keyboardShortcut("n")
        }

        CommandMenu("Shannon") {
            Button("トークを検索") {
                actions?.focusThreadSearch()
            }
            .keyboardShortcut("f")
            .disabled(actions == nil)

            Divider()

            Button("会話") { actions?.showTalk() }
                .keyboardShortcut("1")
                .disabled(actions == nil)
            Button("作業全体") { actions?.showWork() }
                .keyboardShortcut("2")
                .disabled(actions == nil)
            Button("頭の中") { actions?.showMemory() }
                .keyboardShortcut("3")
                .disabled(actions == nil)
            Button("設定") { actions?.showSettings() }
                .keyboardShortcut("4")
                .disabled(actions == nil)
            Button("会話の目次") { actions?.toggleOutline() }
                .keyboardShortcut("o", modifiers: [.command, .option])
                .disabled(actions == nil)
            Button("現在地インスペクタ") { actions?.toggleTaskInspector() }
                .keyboardShortcut("i", modifiers: [.command, .option])
                .disabled(actions == nil)

            Divider()

            Button("会話と作業を更新") {
                Task {
                    await conversation.loadThreads(force: true)
                    await conversation.synchronizeAgentTasks()
                }
            }
            .keyboardShortcut("r")
        }
    }
}

private struct ShannonDeskPreviewConnectionStore: ShannonConnectionStoreProtocol {
    private let credential = ShannonConnectionCredential(
        baseURL: URL(string: "https://sh4nnon.com/companion")!,
        token: String(repeating: "p", count: 43),
        deviceID: "design-preview-mac",
        scopeKey: "design-preview-owner",
        displayName: "このMac",
        expiresAt: Date(timeIntervalSince1970: 4_102_444_800)
    )

    func load() throws -> ShannonConnectionCredential? { credential }
    func save(_ credential: ShannonConnectionCredential) throws {}
    func delete() throws {}
}

private struct ShannonDesktopSettingsScene: View {
    let connection: ShannonConnectionModel
    @Binding var appearanceRawValue: String
    let voiceIdentity: ShannonVoiceIdentityModel
    let worldSubscriptions: ShannonWorldSubscriptionModel
    @State private var showsWorldSubscriptions = false

    var body: some View {
        Form {
            Picker("外観", selection: $appearanceRawValue) {
                ForEach(ShannonAppearanceMode.allCases) { mode in
                    Text(mode.japaneseName).tag(mode.rawValue)
                }
            }
            LabeledContent("接続", value: connection.statusLabel)
            LabeledContent("通信", value: connection.verificationLabel)
            ShannonDesktopVoiceIdentitySettings(model: voiceIdentity)
            Button("情報源（\(worldSubscriptions.summary)）") {
                showsWorldSubscriptions = true
            }
            if connection.isConnected {
                Button("接続を確認") {
                    Task { await connection.verifyConnection() }
                }
                .disabled(connection.isVerifying)
            }
        }
        .formStyle(.grouped)
        .padding(24)
        .frame(width: 540, height: 420)
        .task { await voiceIdentity.reload() }
        .task { await worldSubscriptions.reload() }
        .onDisappear { voiceIdentity.stopPreview() }
        .sheet(isPresented: $showsWorldSubscriptions) {
            ShannonWorldSubscriptionView(model: worldSubscriptions)
                .frame(minWidth: 560, minHeight: 560)
        }
    }
}

private struct ShannonDesktopVoiceIdentitySettings: View {
    @Bindable var model: ShannonVoiceIdentityModel

    var body: some View {
        Picker("シャノンの声", selection: selection) {
            Text("シャノンに任せる").tag("automatic")
            ForEach(model.response.candidates) { candidate in
                Text(candidate.name).tag(candidate.id)
            }
        }
        .disabled(model.savingVoiceID != nil)

        HStack {
            Text("試聴")
            Spacer()
            ForEach(model.response.candidates) { candidate in
                Button {
                    Task { await model.togglePreview(candidate) }
                } label: {
                    Label(
                        candidate.name,
                        systemImage: model.previewingVoiceID == candidate.id ? "stop.fill" : "play.fill"
                    )
                }
            }
        }
        Text("変更は次に始める音声会話から反映され、iPhoneと共有されます。")
            .font(.caption)
            .foregroundStyle(.secondary)
        if let errorMessage = model.errorMessage {
            Text(errorMessage)
                .font(.caption)
                .foregroundStyle(Color.shannonDanger)
        }
    }

    private var selection: Binding<String> {
        Binding(
            get: {
                model.response.preference.mode == .automatic
                    ? "automatic"
                    : model.response.preference.selectedVoice ?? "automatic"
            },
            set: { value in
                Task {
                    if value == "automatic" {
                        await model.selectAutomatic()
                    } else if let candidate = model.response.candidates.first(where: { $0.id == value }) {
                        await model.select(candidate)
                    }
                }
            }
        )
    }
}

private enum ShannonDeskRuntimeConfiguration {
    static let apiBaseURL: URL = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "ShannonAPIBaseURL") as? String
        if let configured,
           !configured.isEmpty,
           !configured.contains("$("),
           let url = URL(string: configured) {
            return url
        }
        return URL(string: "http://127.0.0.1:4317")!
    }()

    static let apiToken: String? = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "ShannonAPIToken") as? String
        guard let configured, !configured.isEmpty, !configured.contains("$(") else { return nil }
        return configured
    }()
}
