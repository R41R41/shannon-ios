import ShannonAppCore
import Foundation
import SwiftUI
#if os(iOS)
import UIKit
@preconcurrency import UserNotifications
#endif

@main
struct ShannonApp: App {
#if os(iOS)
    @UIApplicationDelegateAdaptor(ShannonAppDelegate.self) private var appDelegate
#endif
    @State private var conversationModel: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel
    @State private var memoryModel: ShannonMemoryModel
    @State private var testFlightDeliveryModel: ShannonTestFlightDeliveryModel
    @State private var worldSubscriptionModel: ShannonWorldSubscriptionModel
    @State private var calendarSharingModel: ShannonCalendarSharingModel
    @State private var privateListeningModel: ShannonPrivateListeningModel
    @State private var pendingPushToken: String?
    @Environment(\.scenePhase) private var scenePhase

    init() {
#if os(iOS)
        let deviceDisplayName = UIDevice.current.name
#else
        let deviceDisplayName = "Apple device"
#endif
        let connectionStore = ShannonKeychainConnectionStore()
        let client = ShannonAPIClient(
            baseURL: ShannonRuntimeConfiguration.apiBaseURL,
            apiToken: ShannonRuntimeConfiguration.apiToken,
            connectionStore: connectionStore
        )
#if DEBUG
        let usesDesignPreview = ProcessInfo.processInfo.arguments.contains("-ShannonDesignPreview")
        let initialConversationModel: ShannonConversationModel
        if usesDesignPreview {
            let preview = ShannonConversationModel.designPreview()
            if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewComposer") {
                preview.draft = "この入力欄なら、長い相談も自然に書けそうです"
            }
            initialConversationModel = preview
        } else {
            initialConversationModel = ShannonConversationModel(client: client)
        }
        _conversationModel = State(initialValue: initialConversationModel)
        let previewCalendar = ShannonCalendarSharingStatus.designPreview(
            named: UserDefaults.standard.string(forKey: "ShannonPreviewCalendar")
        )
        _calendarSharingModel = State(initialValue: usesDesignPreview
            ? .designPreview(previewCalendar ?? .off)
            : ShannonCalendarSharingModel(client: client))
        _privateListeningModel = State(initialValue: usesDesignPreview
            ? .designPreview(outputs: [], registered: [], status: .notListening)
            : ShannonPrivateListeningModel(client: client, monitor: ShannonSystemAudioRouteMonitor()))
#else
        _conversationModel = State(initialValue: ShannonConversationModel(client: client))
        _calendarSharingModel = State(initialValue: ShannonCalendarSharingModel(client: client))
        _privateListeningModel = State(initialValue: ShannonPrivateListeningModel(
            client: client, monitor: ShannonSystemAudioRouteMonitor()))
#endif
        _memoryModel = State(initialValue: ShannonMemoryModel(client: client))
        _testFlightDeliveryModel = State(initialValue: ShannonTestFlightDeliveryModel(client: client))
        _worldSubscriptionModel = State(initialValue: ShannonWorldSubscriptionModel(client: client))
        _connectionModel = State(initialValue: ShannonConnectionModel(
            baseURL: ShannonRuntimeConfiguration.apiBaseURL,
            store: connectionStore,
            deviceName: { deviceDisplayName }
        ))
        _pendingPushToken = State(initialValue: nil)
    }

    var body: some Scene {
        WindowGroup {
            ShannonConversationView(
                model: conversationModel,
                connectionModel: connectionModel,
                memoryModel: memoryModel,
                testFlightDeliveryModel: testFlightDeliveryModel,
                worldSubscriptionModel: worldSubscriptionModel
            )
                .shannonCalendarSharing(calendarSharingModel, syncsOnForeground: true)
                // An iPhone app in the background is suspended unless it stands by: it withdraws its report when it leaves the foreground.
                .shannonPrivateListening(privateListeningModel)
                .onOpenURL { url in
                    // `shannon://yousu` opens 「ようす」; every other link is a pairing link, as before.
                    guard !ShannonYousuLink.open(url) else { return }
                    Task { await connectionModel.connect(using: url) }
                }
                .onChange(of: scenePhase) {
                    guard scenePhase == .active, !conversationModel.isDesignPreview else { return }
                    Task {
                        await conversationModel.synchronizeAgentTasks()
                        await refreshInitiativesAndBadge()
                        await configureRemoteNotifications()
                        await registerPendingPushToken()
                    }
                }
                .onChange(of: connectionModel.status) {
                    guard connectionModel.isConnected else { return }
                    Task { await registerPendingPushToken() }
                }
                .onChange(of: conversationModel.totalBadgeCount) {
                    updateApplicationBadge(conversationModel.totalBadgeCount)
                }
#if os(iOS)
                .onReceive(NotificationCenter.default.publisher(for: .shannonPushTokenReceived)) { notification in
                    guard let token = notification.object as? String else { return }
                    pendingPushToken = token
                    Task { await registerPendingPushToken() }
                }
                .onReceive(NotificationCenter.default.publisher(for: .shannonInitiativeNotificationOpened)) { notification in
                    guard let threadId = notification.object as? String else { return }
                    Task { await conversationModel.openInitiativeThread(threadId) }
                }
                .onReceive(NotificationCenter.default.publisher(for: .shannonAgentTaskNotificationOpened)) { notification in
                    guard let taskID = notification.object as? UUID else { return }
                    Task { await conversationModel.openAgentTaskNotification(taskID) }
                }
                .task {
                    guard !conversationModel.isDesignPreview else { return }
                    connectionModel.beforeDisconnect = { [calendarSharingModel] in
                        await calendarSharingModel.removeBeforeUnpairing()
                    }
                    if let url = ShannonAppDelegate.takePendingConnectionURL(), !ShannonYousuLink.open(url) {
                        await connectionModel.connect(using: url)
                    } else if let code = ShannonRuntimeConfiguration.launchPairingCode {
                        await connectionModel.pair(code: code)
                    }
                    await configureRemoteNotifications()
                    if let token = ShannonAppDelegate.takePendingDeviceToken() {
                        pendingPushToken = token
                        await registerPendingPushToken()
                    }
                    if let threadId = ShannonAppDelegate.takePendingInitiativeThreadID() {
                        await conversationModel.openInitiativeThread(threadId)
                    }
                    if let taskID = ShannonAppDelegate.takePendingAgentTaskID() {
                        await conversationModel.openAgentTaskNotification(taskID)
                    }
                    if ShannonAppDelegate.takePendingTestFlightDeliveryOpen() {
                        NotificationCenter.default.post(
                            name: .shannonTestFlightDeliveryNotificationOpened,
                            object: nil
                        )
                    }
                }
#endif
        }
    }

    private func refreshInitiativesAndBadge() async {
        await conversationModel.refreshInitiatives()
        updateApplicationBadge(conversationModel.totalBadgeCount)
    }

    private func updateApplicationBadge(_ count: Int) {
#if os(iOS)
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count)) }
#endif
    }

#if os(iOS)
    private func configureRemoteNotifications() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
        }
        let refreshed = await center.notificationSettings()
        guard refreshed.authorizationStatus != .denied else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    private func registerPendingPushToken() async {
        guard connectionModel.isConnected, let token = pendingPushToken else { return }
        let registered = await conversationModel.registerPushToken(token, environment: pushEnvironment)
        if registered, pendingPushToken == token { pendingPushToken = nil }
    }

    private var pushEnvironment: ShannonPushEnvironmentDTO {
#if DEBUG
        .sandbox
#else
        .production
#endif
    }
#endif
}

#if os(iOS)
@MainActor
private final class ShannonAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private static var pendingConnectionURL: URL?
    private static var pendingDeviceToken: String?
    private static var pendingInitiativeThreadID: String?
    private static var pendingAgentTaskID: UUID?
    private static var pendingTestFlightDeliveryOpen = false

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Self.pendingConnectionURL = launchOptions?[.url] as? URL
        Self.pendingInitiativeThreadID = Self.threadID(from: launchOptions?[.remoteNotification])
        Self.pendingAgentTaskID = Self.taskID(from: launchOptions?[.remoteNotification])
        Self.pendingTestFlightDeliveryOpen = Self.isTestFlightFailure(launchOptions?[.remoteNotification])
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Self.pendingDeviceToken = token
        NotificationCenter.default.post(name: .shannonPushTokenReceived, object: token)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // The app retries APNs registration on the next foreground activation.
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        Self.pendingConnectionURL = url
        return true
    }

    static func takePendingConnectionURL() -> URL? {
        defer { pendingConnectionURL = nil }
        return pendingConnectionURL
    }

    static func takePendingDeviceToken() -> String? {
        defer { pendingDeviceToken = nil }
        return pendingDeviceToken
    }

    static func takePendingInitiativeThreadID() -> String? {
        defer { pendingInitiativeThreadID = nil }
        return pendingInitiativeThreadID
    }

    static func takePendingAgentTaskID() -> UUID? {
        defer { pendingAgentTaskID = nil }
        return pendingAgentTaskID
    }

    static func takePendingTestFlightDeliveryOpen() -> Bool {
        defer { pendingTestFlightDeliveryOpen = false }
        return pendingTestFlightDeliveryOpen
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let payload = response.notification.request.content.userInfo
        await MainActor.run {
            if Self.isTestFlightFailure(payload) {
                Self.pendingTestFlightDeliveryOpen = true
                NotificationCenter.default.post(
                    name: .shannonTestFlightDeliveryNotificationOpened,
                    object: nil
                )
            } else if let taskID = Self.taskID(from: payload) {
                Self.pendingAgentTaskID = taskID
                NotificationCenter.default.post(name: .shannonAgentTaskNotificationOpened, object: taskID)
            } else if let threadId = Self.threadID(from: payload) {
                Self.pendingInitiativeThreadID = threadId
                NotificationCenter.default.post(name: .shannonInitiativeNotificationOpened, object: threadId)
            }
        }
    }

    nonisolated private static func threadID(from payload: Any?) -> String? {
        guard let dictionary = payload as? [AnyHashable: Any],
              let threadId = dictionary["threadId"] as? String,
              !threadId.isEmpty else { return nil }
        return threadId
    }

    nonisolated private static func taskID(from payload: Any?) -> UUID? {
        guard let dictionary = payload as? [AnyHashable: Any],
              let taskID = dictionary["taskId"] as? String else { return nil }
        return UUID(uuidString: taskID)
    }

    nonisolated private static func isTestFlightFailure(_ payload: Any?) -> Bool {
        guard let dictionary = payload as? [AnyHashable: Any] else { return false }
        return dictionary["kind"] as? String == "testflight_failure"
    }
}

private extension Notification.Name {
    static let shannonPushTokenReceived = Notification.Name("ShannonPushTokenReceived")
    static let shannonInitiativeNotificationOpened = Notification.Name("ShannonInitiativeNotificationOpened")
    static let shannonAgentTaskNotificationOpened = Notification.Name("ShannonAgentTaskNotificationOpened")
}
#endif
private enum ShannonRuntimeConfiguration {
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

    static let launchPairingCode: String? = {
        let code = ProcessInfo.processInfo.environment["SHANNON_PAIRING_CODE"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return code?.isEmpty == false ? code : nil
    }()
}
