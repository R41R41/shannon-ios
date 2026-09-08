import AppKit
import ShannonAppCore
import SwiftUI

@main
struct ShannonDeskApp: App {
    @State private var conversationModel: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel
    @State private var memoryModel: ShannonMemoryModel
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
    }

    var body: some Scene {
        WindowGroup {
            ShannonDesktopRootView(
                conversation: conversationModel,
                connection: connectionModel,
                memory: memoryModel
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
            CommandGroup(replacing: .newItem) {
                Button("新しいトーク") {
                    Task { await conversationModel.createThread(title: nil) }
                }
                .keyboardShortcut("n")
            }
            CommandMenu("Shannon") {
                Button("会話と作業を更新") {
                    Task {
                        await conversationModel.loadThreads(force: true)
                        await conversationModel.synchronizeAgentTasks()
                    }
                }
                .keyboardShortcut("r")
            }
        }

        Settings {
            ShannonDesktopSettingsScene(
                connection: connectionModel,
                appearanceRawValue: $appearanceRawValue
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

    var body: some View {
        Form {
            Picker("外観", selection: $appearanceRawValue) {
                ForEach(ShannonAppearanceMode.allCases) { mode in
                    Text(mode.japaneseName).tag(mode.rawValue)
                }
            }
            LabeledContent("接続", value: connection.statusLabel)
            LabeledContent("通信", value: connection.verificationLabel)
            if connection.isConnected {
                Button("接続を確認") {
                    Task { await connection.verifyConnection() }
                }
                .disabled(connection.isVerifying)
            }
        }
        .formStyle(.grouped)
        .padding(24)
        .frame(width: 440, height: 280)
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
