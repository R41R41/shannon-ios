import Foundation
@preconcurrency import UserNotifications

/// `timer.start`: a local notification at the time the server computed (`fireAt`), so a timer taken a little late
/// still rings when it was meant to. A time already past is reported as `past` and nothing is scheduled.
enum ShannonDeviceTimers {
    static func start(_ action: ShannonDeviceActionDTO, now: Date = Date()) async -> ShannonDeviceActionReportDTO {
        guard let fireText = action.string("fireAt"), let fireAt = ShannonDeviceActionClock.date(fireText) else { return .failed(.invalid) }
        let interval = fireAt.timeIntervalSince(now)
        guard interval >= 1 else { return .failed(.past) }
        let center = UNUserNotificationCenter.current()
        guard await authorized(center) else { return .denied() }
        let content = UNMutableNotificationContent()
        content.title = action.string("label").map { "タイマー: \($0)" } ?? "タイマー"
        content.body = "時間です。"
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        let request = UNNotificationRequest(identifier: "shannon.timer.\(action.id)", content: content, trigger: trigger)
        do {
            try await center.add(request)
            return .done(["fireAt": .string(fireText)])
        } catch {
            return .failed(.failed)
        }
    }

    private static func authorized(_ center: UNUserNotificationCenter) async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional: return true
        case .notDetermined: return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        default: return false
        }
    }
}
