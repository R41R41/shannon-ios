import AppKit
import ShannonAppCore
@preconcurrency import UserNotifications

/// Shows the Mac's notifications (roadmap A13) and opens their place when one is pressed.
/// They are made on this Mac from what the app already reads (the work tasks and her unread
/// messages, polled while the app runs), so the app needs no push credential.
@MainActor
final class ShannonDesktopNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ShannonDesktopNotifier()
    static let deliveredKey = "shannon.desktop.notifications.delivered"

    /// The place of a notification pressed before a window could open it.
    private(set) var pendingTarget: DesktopNotice.Target?
    private var didStart = false
    /// Set once the window has read the tasks and her messages a first time.
    private(set) var isWatching = false
    private var isAuthorized = false
    private let defaults = UserDefaults.standard

    /// Asks once for permission and starts receiving presses.
    func start() async {
        guard !didStart else { return }
        didStart = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            isAuthorized = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        } else {
            isAuthorized = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        }
    }

    /// Notifies of what is new since the last look. The first look only remembers.
    func update(_ notices: [DesktopNotice]) {
        isWatching = true
        let plan = DesktopNotificationPlan.toPost(notices, delivered: defaults.stringArray(forKey: Self.deliveredKey))
        defaults.set(plan.delivered, forKey: Self.deliveredKey)
        guard isAuthorized else { return }
        for notice in plan.post {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.sound = .default
            switch notice.target {
            case .task(let id): content.userInfo = ["taskId": id.uuidString]
            case .thread(let threadId):
                content.userInfo = ["threadId": threadId]
                content.threadIdentifier = threadId
            }
            let request = UNNotificationRequest(identifier: notice.key, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request) { _ in }
        }
    }

    func takePendingTarget() -> DesktopNotice.Target? {
        defer { pendingTarget = nil }
        return pendingTarget
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let target: DesktopNotice.Target?
        if let task = (info["taskId"] as? String).flatMap(UUID.init(uuidString:)) {
            target = .task(task)
        } else if let thread = info["threadId"] as? String, !thread.isEmpty {
            target = .thread(thread)
        } else {
            target = nil
        }
        guard let target else { return }
        await MainActor.run {
            pendingTarget = target
            NSApp.activate(ignoringOtherApps: true)
            NotificationCenter.default.post(name: .shannonDesktopNotificationOpened, object: nil)
        }
    }
}

extension Notification.Name {
    static let shannonDesktopNotificationOpened = Notification.Name("ShannonDesktopNotificationOpened")
}

extension ShannonDesktopRootView {
    /// What the window currently has to tell, in notification form.
    var desktopNotices: [DesktopNotice] {
        DesktopNotificationPlan.notices(
            tasks: conversation.agentTasks,
            needsNotice: conversation.agentTaskNeedsNotice,
            initiatives: conversation.unreadInitiativeMessages
        )
    }

    var desktopNoticeKeys: [String] { desktopNotices.map(\.key) }

    func openNotificationTarget() {
        switch ShannonDesktopNotifier.shared.takePendingTarget() {
        case .task(let id):
            selectDestination(.work)
            selectedTaskID = id
            showAuxiliaryPanel(.task)
        case .thread(let threadId):
            Task {
                await conversation.openInitiativeThread(threadId)
                selectDestination(.talk)
            }
        case nil:
            break
        }
    }
}
