import Foundation

/// What the settings row says about calendar sharing.
public enum ShannonCalendarSharingStatus: Equatable, Sendable {
    case off
    /// Switched off, but the server could not be reached to remove the snapshot yet.
    case removalPending
    /// This device is not paired with Shannon; only a paired device shares.
    case notPaired
    case needsPermission
    /// On and permitted, nothing sent yet.
    case waiting
    case sending
    case sent(at: Date, count: Int)
    /// The server has no calendar route yet (404). Retried on the next sync.
    case unsupported
    case failed(lastSentAt: Date?, count: Int)

    var showsToggleOn: Bool {
        switch self {
        case .off, .removalPending, .notPaired: false
        default: true
        }
    }

    public var needsPermission: Bool { self == .needsPermission }

    /// Fixed state named by the `-ShannonPreviewCalendar <name>` launch argument (design previews only).
    public static func designPreview(named name: String?, now: Date = Date()) -> ShannonCalendarSharingStatus? {
        switch name {
        case "off": .off
        case "sent": .sent(at: now, count: 12)
        case "permission": .needsPermission
        case "unsupported": .unsupported
        case "failed": .failed(lastSentAt: now, count: 12)
        case "removal": .removalPending
        default: nil
        }
    }
}

/// Wording of the calendar-sharing settings. Neutral status text, not Shannon's voice.
public enum ShannonCalendarSharingCopy {
    public static let sectionTitle = "予定"
    public static let toggleTitle = "カレンダーの予定をシャノンに伝える"
    public static let explanation = "予定の題名・時刻・場所・カレンダー名・参加者の名前・繰り返しかどうかを、"
        + "今日から30日ぶんだけシャノンのサーバーへ送ります。"
        + "シャノンが予定を知って、声をかけたり答えたり、予定や空いている時間を探したりするために使います。"
        + "メモ・URLは送りません。オフにすると、送った予定をサーバーから削除します。"
    public static let openSettingsTitle = "カレンダーの権限を設定で開く"
    public static let toggleHint = "オンにするとカレンダーの予定を読み取り、今日から30日ぶんをシャノンのサーバーへ送ります。"
        + "オフにすると送った予定をサーバーから削除します"

    public static func statusText(
        _ status: ShannonCalendarSharingStatus,
        timeZone: TimeZone = .current
    ) -> String {
        switch status {
        case .off:
            "送っていません"
        case .removalPending:
            "送った予定の削除を待っています。接続できたときに削除します"
        case .notPaired:
            "シャノンに接続すると送れます"
        case .needsPermission:
            "権限がありません"
        case .waiting:
            "まだ送っていません"
        case .sending:
            "送信中…"
        case .sent(let at, let count):
            sentText(at: at, count: count, timeZone: timeZone)
        case .unsupported:
            "サーバーが未対応です。対応したら自動で送ります"
        case .failed(let lastSentAt, let count):
            if let lastSentAt {
                "送れませんでした。次の機会にもう一度送ります（\(sentText(at: lastSentAt, count: count, timeZone: timeZone))）"
            } else {
                "送れませんでした。次の機会にもう一度送ります"
            }
        }
    }

    static func sentText(at: Date, count: Int, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.month, .day, .hour, .minute], from: at)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        return "最終送信 \(parts.month ?? 0)月\(parts.day ?? 0)日 \(time)・\(count)件"
    }
}

public enum ShannonCalendarSyncTrigger: Equatable, Sendable {
    /// The owner just switched sharing on.
    case enabled
    case launch
    case foreground
    case storeChanged
    case periodic
}

/// When a sync may run. Switching on, launch and a settled calendar change always send;
/// returning to the foreground and the periodic tick are spaced out.
public struct ShannonCalendarSyncGate: Equatable, Sendable {
    public static let phoneInterval: TimeInterval = 15 * 60
    public static let macInterval: TimeInterval = 30 * 60
    public static let foregroundInterval: TimeInterval = 60
    public static let changeDebounce: TimeInterval = 5
    /// A timer that fires a moment early still counts as the interval.
    static let periodicTolerance: TimeInterval = 30

    public let periodicInterval: TimeInterval
    public private(set) var lastAttempt: Date?

    public init(periodicInterval: TimeInterval = ShannonCalendarSyncGate.phoneInterval) {
        self.periodicInterval = periodicInterval
    }

    public func allows(_ trigger: ShannonCalendarSyncTrigger, now: Date) -> Bool {
        guard let lastAttempt else { return true }
        let elapsed = now.timeIntervalSince(lastAttempt)
        switch trigger {
        case .enabled, .launch, .storeChanged: return true
        case .foreground: return elapsed >= Self.foregroundInterval
        case .periodic: return elapsed >= periodicInterval - Self.periodicTolerance
        }
    }

    public mutating func record(_ moment: Date) {
        lastAttempt = moment
    }
}
