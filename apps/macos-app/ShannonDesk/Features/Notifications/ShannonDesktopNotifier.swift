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
    private var didInstall = false
    private var didAsk = false
    private var isAuthorized = false
    private let defaults = UserDefaults.standard

    /// At launch, before any window: a notification pressed while the app was not running is
    /// delivered to the delegate as the app starts, and must find it. Also reads the permission
    /// again whenever the app becomes active (it can be changed in System Settings).
    func install() {
        guard !didInstall else { return }
        didInstall = true
        UNUserNotificationCenter.current().delegate = self
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in await ShannonDesktopNotifier.shared.readAuthorization() }
        }
    }

    /// Asks once for permission (from the window, once it has read what there is to tell).
    func start() async {
        install()
        guard !didAsk else { return await readAuthorization() }
        didAsk = true
        let center = UNUserNotificationCenter.current()
        if await center.notificationSettings().authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        await readAuthorization()
    }

    func readAuthorization() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        isAuthorized = status == .authorized || status == .provisional
    }

    /// Notifies of what is new since the last look (`DesktopNotificationPlan.toPost`).
    func update(_ notices: [DesktopNotice], readSucceeded: Bool, held: Bool = false) {
        guard didAsk else { return }
        let plan = DesktopNotificationPlan.toPost(
            notices, delivered: defaults.stringArray(forKey: Self.deliveredKey),
            readSucceeded: readSucceeded, authorized: isAuthorized, held: held
        )
        if let delivered = plan.delivered { defaults.set(delivered, forKey: Self.deliveredKey) }
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

    /// Banners wait during 「友人も一緒」 and while 配信用の出力（OBS） is on (A18 S5).
    var notificationsHeld: Bool {
        DesktopNotificationPlan.isHeld(guestCall: voiceCall.session.hidesOwnerScreens, streamOutputOn: ShannonStreamOutput.shared.isOn)
    }

    /// The tasks and her messages were read from the server while connected, in this launch.
    var noticesReadSucceeded: Bool {
        connection.isConnected && conversation.agentTasksReadAt != nil && conversation.initiativesReadAt != nil
    }

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
