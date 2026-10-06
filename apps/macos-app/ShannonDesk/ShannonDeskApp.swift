import AppKit
import ShannonAppCore
import SwiftUI

@main
struct ShannonDeskApp: App {
    /// Quitting during a voice conversation ends the call and lets its end reach the server first (A16).
    @NSApplicationDelegateAdaptor(ShannonDesktopAppDelegate.self) private var appDelegate
    @State private var conversationModel: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel
    @State private var memoryModel: ShannonMemoryModel
    @State private var voiceIdentityModel: ShannonVoiceIdentityModel
    @State private var worldSubscriptionModel: ShannonWorldSubscriptionModel
    @State private var releaseModel: ShannonTestFlightDeliveryModel
    @State private var appIconModel: ShannonAppIconModel
    @State private var calendarSharingModel: ShannonCalendarSharingModel
    @State private var privateListeningModel: ShannonPrivateListeningModel
    /// The voice conversation (A16), one for the app: it outlives the page and the window it was started from.
    @State private var voiceCall: ShannonDesktopVoiceCall
    @AppStorage(ShannonAppearanceMode.storageKey) private var appearanceRawValue = ShannonAppearanceMode.system.rawValue

    init() {
#if DEBUG
        let usesDesignPreview = ProcessInfo.processInfo.arguments.contains("-ShannonDesignPreview")
            || (Bundle.main.object(forInfoDictionaryKey: "ShannonDesignPreview") as? Bool == true)
        let connectionStore: any ShannonConnectionStoreProtocol = usesDesignPreview
            ? ShannonDeskPreviewConnectionStore()
            : ShannonKeychainConnectionStore()
#else
        let connectionStore: any ShannonConnectionStoreProtocol = ShannonKeychainConnectionStore()
#endif
        let client = ShannonAPIClient(
            baseURL: ShannonDeskRuntimeConfiguration.apiBaseURL,
            apiToken: ShannonDeskRuntimeConfiguration.apiToken,
            connectionStore: connectionStore
        )
#if DEBUG
        let conversation = usesDesignPreview
            ? ShannonConversationModel.designPreview()
            : ShannonConversationModel(client: client)
        let previewCalendar = ShannonCalendarSharingStatus.designPreview(
            named: UserDefaults.standard.string(forKey: "ShannonPreviewCalendar")
        )
        let calendarSharing: ShannonCalendarSharingModel = usesDesignPreview
            ? .designPreview(previewCalendar ?? .off)
            : ShannonCalendarSharingModel(client: client, periodicInterval: ShannonCalendarSyncGate.macInterval)
#else
        let conversation = ShannonConversationModel(client: client)
        let calendarSharing = ShannonCalendarSharingModel(
            client: client,
            periodicInterval: ShannonCalendarSyncGate.macInterval
        )
#endif
        _conversationModel = State(initialValue: conversation)
        _calendarSharingModel = State(initialValue: calendarSharing)
        // Her desktop body (A17): one for the app, with the app's call. Shown after launch if the owner left her out;
        // in the design preview only when asked (-ShannonPreviewDesktopBody), and it never sends anything there.
        let voiceCall = ShannonDesktopVoiceCall()
        _voiceCall = State(initialValue: voiceCall)
        ShannonDesktopBody.shared.configure(conversation: conversation, voiceCall: voiceCall)
#if DEBUG
        let showsDesktopBody = !usesDesignPreview || ProcessInfo.processInfo.arguments.contains("-ShannonPreviewDesktopBody")
#else
        let showsDesktopBody = true
#endif
#if DEBUG
        let hostsFolder = !usesDesignPreview
#else
        let hostsFolder = true
#endif
        ShannonDesktopAppDelegate.didFinishLaunching = {
            ShannonDesktopBody.shared.start(showsWindow: showsDesktopBody)
            // Her folder on this Mac (A18): resolved and hosted from launch while one is chosen; never in the design preview.
            if hostsFolder { ShannonFolderHostModel.shared.start(api: client) }
            // 配信用の出力（OBS, A18 S5): listens again if the owner left it on; never in the design preview.
            if hostsFolder { ShannonStreamOutput.shared.start() }
        }
#if DEBUG
        _privateListeningModel = State(initialValue: usesDesignPreview
            ? .designPreview(outputs: [], registered: [], status: .notListening)
            : ShannonPrivateListeningModel(client: client, monitor: ShannonSystemAudioRouteMonitor()))
#else
        _privateListeningModel = State(initialValue: ShannonPrivateListeningModel(
            client: client, monitor: ShannonSystemAudioRouteMonitor()))
#endif
        let connection = ShannonConnectionModel(
            baseURL: ShannonDeskRuntimeConfiguration.apiBaseURL,
            store: connectionStore,
            deviceName: { Host.current().localizedName ?? "Mac" }
        )
        connection.beforeDisconnect = { await calendarSharing.removeBeforeUnpairing() }
        _connectionModel = State(initialValue: connection)
        _memoryModel = State(initialValue: ShannonMemoryModel(client: client))
        _voiceIdentityModel = State(initialValue: ShannonVoiceIdentityModel(client: client))
        _worldSubscriptionModel = State(initialValue: ShannonWorldSubscriptionModel(client: client))
        _releaseModel = State(initialValue: ShannonTestFlightDeliveryModel(client: client))
        // A pressed notification that launches the app reaches its delegate as the app starts (A13).
        ShannonDesktopNotifier.shared.install()
        let appIconModel = ShannonAppIconModel()
        appIconModel.restoreMacApplicationIconBeforeWindowCreation()
        _appIconModel = State(initialValue: appIconModel)
    }

    var body: some Scene {
        WindowGroup(id: ShannonDeskCommands.mainWindowID) {
            ShannonDesktopRootView(
                conversation: conversationModel,
                connection: connectionModel,
                memory: memoryModel,
                voiceIdentity: voiceIdentityModel,
                worldSubscriptions: worldSubscriptionModel,
                release: releaseModel,
                appIcon: appIconModel,
                voiceCall: voiceCall
            )
            .preferredColorScheme(preferredColorScheme)
            .shannonCalendarSharing(calendarSharingModel, syncsOnForeground: false)
            // The Mac app runs whether or not its window is in front, so its report stays fresh and she can speak.
            .shannonEarphoneSpeaking(conversation: conversationModel)
            .shannonPrivateListening(privateListeningModel)
            .onOpenURL { url in
                // shannon://yousu and shannon://admin/ops open ようす and 設定 › 管理 › 運用.
                if ShannonYousuLink.open(url) { return }
                Task {
                    if await connectionModel.connect(using: url) {
                        await connectionModel.verifyConnection()
                    }
                }
            }
        }
        // The root view owns the 860×600 minimum. Content-driven scene sizing and a
        // restored SwiftUI inspector can otherwise re-enter AppKit's constraint pass.
        .defaultSize(width: previewWindowSize.width, height: previewWindowSize.height)
        .commands {
            ShannonDeskCommands(conversation: conversationModel, voiceCall: voiceCall)
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch ShannonAppearanceMode(rawValue: appearanceRawValue) ?? .system {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    private var previewWindowSize: CGSize {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewCompact") {
            return CGSize(width: 860, height: 600)
        }
#endif
        return CGSize(width: 1220, height: 790)
    }
}

private struct ShannonDeskCommands: Commands {
    static let mainWindowID = "main"
    let conversation: ShannonConversationModel
    /// During 「友人も一緒」 a new Talk is not made: his hidden draft and attachments would silently go (A16).
    let voiceCall: ShannonDesktopVoiceCall
    @FocusedValue(\.shannonDesktopCommandActions) private var actions
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        // ⌘, opens the same 設定 as the sidebar (docs/product/information-architecture.md 2), in the
        // window in front, or in a new window when none is open. There is no separate Settings window.
        CommandGroup(replacing: .appSettings) {
            Button("\(ShannonGeneratedStrings.navSettings)…") {
                if let actions {
                    actions.showSettings()
                } else {
                    UserDefaults.standard.set(DesktopDestination.settings.rawValue, forKey: ShannonDesktopWindowRestoration.lastDestinationKey)
                    openWindow(id: Self.mainWindowID)
                }
            }
            .keyboardShortcut(",")
        }

        CommandGroup(replacing: .newItem) {
            Button("新しいトーク") {
                Task { await conversation.createThread(title: nil) }
                actions?.showTalk()
            }
            .keyboardShortcut("n")
            .disabled(voiceCall.session.hidesOwnerScreens)
        }

        CommandMenu("Shannon") {
            Button("トークを検索") {
                actions?.focusThreadSearch()
            }
            .keyboardShortcut("f")
            .disabled(actions == nil)

            Divider()

            Button(ShannonGeneratedStrings.navTalk) { actions?.showTalk() }
                .keyboardShortcut("1")
                .disabled(actions == nil)
            Button(ShannonGeneratedStrings.navWork) { actions?.showWork() }
                .keyboardShortcut("2")
                .disabled(actions == nil)
            Button(ShannonGeneratedStrings.navShannon) { actions?.showShannon() }
                .keyboardShortcut("3")
                .disabled(actions == nil)
            Button(ShannonGeneratedStrings.navSettings) { actions?.showSettings() }
                .keyboardShortcut("4")
                .disabled(actions == nil)
            // 開発 and 配信 are pages of 作業 (roadmap A10).
            Button(ShannonGeneratedStrings.navDevelopment) { actions?.showDevelopment() }
                .keyboardShortcut("5")
                .disabled(actions == nil)
            Button(ShannonGeneratedStrings.navDelivery) { actions?.showRelease() }
                .keyboardShortcut("6")
                .disabled(actions == nil)
            Button("会話の目次") { actions?.toggleOutline() }
                .keyboardShortcut("o", modifiers: [.command, .option])
                .disabled(actions == nil)
            Button("現在地インスペクタ") { actions?.toggleTaskInspector() }
                .keyboardShortcut("i", modifiers: [.command, .option])
                .disabled(actions == nil)
            Button(ShannonGeneratedStrings.settingsFigure) { actions?.toggleFigure() }
                .keyboardShortcut("f", modifiers: [.command, .option])
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
