import Foundation

/// One control the screen may show for a row.
public struct ShannonOpsAction: Equatable, Identifiable, Sendable {
    public let type: ShannonOpsCommandType
    /// A service id, a Minecraft server (`minecraft:<name>`), or a schedule name.
    public let target: String
    /// The readable name of the target, as the confirmation words it.
    public let name: String
    /// Only for `schedule.run`: what the latest report says about today.
    public let postedToday: Bool?

    public var id: String { "\(type.rawValue)\u{0}\(target)" }

    public init(type: ShannonOpsCommandType, target: String, name: String, postedToday: Bool? = nil) {
        self.type = type
        self.target = target
        self.name = name
        self.postedToday = postedToday
    }
}

/// The operator wording of the operations console, the same as the Windows app
/// (`shannon-desktop/src/desk/opsText.ts`). Status and result text is neutral, never
/// Shannon speaking. The confirmation sentences are promises to the owner: they are
/// kept word for word, and `ShannonYousuOpsTests` holds them.
public enum ShannonOpsText {
    public static let minebotBody = "minebot:bot"
    static let minecraftPrefix = "minecraft:"

    public static func statusLabel(_ status: ShannonOpsStatus) -> String {
        switch status {
        case .running: ShannonGeneratedStrings.opsStatusRunning
        case .stopped: ShannonGeneratedStrings.opsStatusStopped
        case .degraded: ShannonGeneratedStrings.opsStatusDegraded
        case .unknown: ShannonGeneratedStrings.opsStatusUnknown
        }
    }

    /// The same state in a report that is no longer current: never worded as the present.
    public static func staleStatusLabel(_ status: ShannonOpsStatus) -> String {
        switch status {
        case .running: "動いていた"
        case .stopped: "止まっていた"
        case .degraded: "不調だった"
        case .unknown: ShannonGeneratedStrings.opsStatusUnknown
        }
    }

    private static let serviceNames: [String: String] = [
        "discord": "Discord", "minebot": ShannonGeneratedStrings.opsServiceMinebot, "minebot:bot": ShannonGeneratedStrings.opsServiceMinebotBody, "minecraft": "Minecraft",
        "notion": "Notion", "youtube": "YouTube", "youtube:live_chat": ShannonGeneratedStrings.opsServiceYoutubeLiveChat,
        "twitter": ShannonGeneratedStrings.opsServiceTwitter, "x": ShannonGeneratedStrings.opsServiceTwitter, "line": "LINE", "web": "Web",
    ]

    public static func serviceName(id: String, label: String) -> String {
        if let known = serviceNames[id] { return known }
        if id.hasPrefix(minecraftPrefix) { return ShannonGeneratedStrings.opsServiceMinecraftServer(name: String(id.dropFirst(minecraftPrefix.count))) }
        return !label.isEmpty && label != id ? label : id
    }

    public static func serviceName(_ service: ShannonOpsServiceDTO) -> String {
        serviceName(id: service.id, label: service.label)
    }

    public static func commandLabel(_ type: ShannonOpsCommandType) -> String {
        switch type {
        case .serviceStart, .minecraftStart: ShannonGeneratedStrings.opsCommandStart
        case .serviceStop, .minecraftStop: ShannonGeneratedStrings.opsCommandStop
        case .scheduleRun: ShannonGeneratedStrings.opsCommandRunNow
        case .minebotStart: ShannonGeneratedStrings.opsCommandLaunch
        }
    }

    public static func commandStatusLabel(_ status: ShannonOpsCommandStatus) -> String {
        switch status {
        case .pending: ShannonGeneratedStrings.opsCommandStatusPending
        case .claimed: ShannonGeneratedStrings.opsCommandStatusClaimed
        case .done: ShannonGeneratedStrings.opsCommandStatusDone
        case .failed: ShannonGeneratedStrings.opsCommandStatusFailed
        case .refused: ShannonGeneratedStrings.opsCommandStatusRefused
        case .expired: ShannonGeneratedStrings.opsCommandStatusExpired
        case .unknown: ShannonGeneratedStrings.opsStatusUnknown
        }
    }

    private static let codeLabels: [String: String] = [
        "not_registered": ShannonGeneratedStrings.opsCodeNotRegistered,
        "already_running": ShannonGeneratedStrings.opsCodeAlreadyRunning,
        "already_stopped": ShannonGeneratedStrings.opsCodeAlreadyStopped,
        "busy": ShannonGeneratedStrings.opsCodeBusy,
        "lab_running": ShannonGeneratedStrings.opsCodeLabRunning,
        "timeout": ShannonGeneratedStrings.opsCodeTimeout,
        "error": ShannonGeneratedStrings.opsCodeError,
        "unsupported": ShannonGeneratedStrings.opsCodeUnsupported,
        "not_allowed": ShannonGeneratedStrings.opsCodeNotAllowed,
        "no_report": ShannonGeneratedStrings.opsCodeNoReport,
    ]

    /// For starting the Minebot body the same words mean something else (server contract).
    private static let minebotStartCodeLabels: [String: String] = [
        "already_stopped": ShannonGeneratedStrings.opsCodeMinebotStartAlreadyStopped,
        "already_running": ShannonGeneratedStrings.opsCodeMinebotStartAlreadyRunning,
        "lab_running": ShannonGeneratedStrings.opsCodeMinebotStartLabRunning,
        "not_registered": ShannonGeneratedStrings.opsCodeMinebotStartNotRegistered,
    ]

    /// The reason of a result. A word this app does not know is shown as it arrived.
    public static func commandCodeLabel(_ code: String, type: ShannonOpsCommandType? = nil) -> String {
        (type == .minebotStart ? minebotStartCodeLabels[code] : nil) ?? codeLabels[code] ?? code
    }

    /// The reason shown beside a finished command: its code, or what an expiry means.
    public static func commandReason(_ command: ShannonOpsCommandDTO) -> String? {
        if let code = command.code { return commandCodeLabel(code, type: command.type) }
        return command.status == .expired ? ShannonGeneratedStrings.opsCodeExpired : nil
    }

    public static func commandTargetName(type: ShannonOpsCommandType, target: String) -> String {
        if type == .scheduleRun { return ShannonGeneratedStrings.opsTargetSchedule(name: target) }
        let name = serviceName(id: target, label: target)
        return type == .minebotStart ? ShannonGeneratedStrings.opsTargetMinebotBody(name: name) : name
    }

    /// 「YouTube を停止」: one line of the record of operations.
    public static func commandSummary(_ command: ShannonOpsCommandDTO) -> String {
        "\(commandTargetName(type: command.type, target: command.target)) を\(commandLabel(command.type))"
    }

    /// Minecraft servers the Minebot body can join: only the ones running now.
    public static func minebotServers(_ services: [ShannonOpsServiceDTO]) -> [ShannonOpsServiceDTO] {
        services.filter { $0.id.hasPrefix(minecraftPrefix) && !isLabServer($0.id) && $0.status == .running }
    }

    /// Lab servers are never manageable (`docs/ops-contract.md`): `allowed.minecraft` does not cover them.
    static func isLabServer(_ id: String) -> Bool {
        id.hasPrefix("minecraft:progressive-lab-") || id.hasPrefix("progressive-lab-")
    }

    /// The controls for one service: only what the server said it would accept (`allowed`).
    /// A running one offers 停止, a stopped one 開始, and 不調 or 不明 both. The Minebot body
    /// is never started with a plain 開始: the screen offers 起動 with a server instead.
    public static func serviceActions(_ service: ShannonOpsServiceDTO, allowed: ShannonOpsAllowedDTO) -> [ShannonOpsAction] {
        guard !isLabServer(service.id) else { return [] }
        let isServer = service.id.hasPrefix(minecraftPrefix)
        let canStart = service.id == minebotBody ? false : isServer ? allowed.minecraft : allowed.serviceStart.contains(service.id)
        let canStop = isServer ? allowed.minecraft : allowed.serviceStop.contains(service.id)
        let name = serviceName(service)
        var actions: [ShannonOpsAction] = []
        if canStart, service.status != .running {
            actions.append(.init(type: isServer ? .minecraftStart : .serviceStart, target: service.id, name: name))
        }
        if canStop, service.status != .stopped {
            actions.append(.init(type: isServer ? .minecraftStop : .serviceStop, target: service.id, name: name))
        }
        return actions
    }

    /// 「今すぐ実行」 for a schedule, when the server accepts it.
    public static func scheduleAction(_ schedule: ShannonOpsScheduleDTO, allowed: ShannonOpsAllowedDTO) -> ShannonOpsAction? {
        allowed.scheduleRun
            ? .init(type: .scheduleRun, target: schedule.name, name: schedule.name, postedToday: schedule.postedToday)
            : nil
    }

    /// What the owner is asked before anything is sent. Kept word for word with the Windows app.
    public static func confirmationText(_ type: ShannonOpsCommandType, name: String, postedToday: Bool? = nil) -> String {
        switch type {
        case .scheduleRun:
            return [
                ShannonGeneratedStrings.opsConfirmScheduleRunQuestion(name: name),
                "",
                ShannonGeneratedStrings.opsConfirmScheduleRunConsequence,
                postedToday == true
                    ? ShannonGeneratedStrings.opsConfirmScheduleRunPostedToday
                    : ShannonGeneratedStrings.opsConfirmScheduleRunMaybePosted,
            ].joined(separator: "\n")
        case .minebotStart:
            // These two sentences are a promise to the owner (2026-10-02). The wording does not change.
            return [
                ShannonGeneratedStrings.opsConfirmMinebotStartQuestion(name: name),
                "",
                ShannonGeneratedStrings.opsConfirmMinebotStartCost,
                ShannonGeneratedStrings.opsConfirmMinebotStartVersion,
            ].joined(separator: "\n")
        case .serviceStop, .minecraftStop:
            return ShannonGeneratedStrings.opsConfirmStop(name: name)
        case .serviceStart, .minecraftStart:
            return ShannonGeneratedStrings.opsConfirmStart(name: name)
        }
    }

    public static func confirmationText(_ action: ShannonOpsAction) -> String {
        confirmationText(action.type, name: action.name, postedToday: action.postedToday)
    }

    /// The title of the confirmation sheet.
    public static func confirmationTitle(_ action: ShannonOpsAction) -> String {
        switch action.type {
        case .minebotStart: "Minebot の体を起動"
        case .scheduleRun: "予定を今すぐ実行"
        case .serviceStart, .minecraftStart: "\(action.name) を開始"
        case .serviceStop, .minecraftStop: "\(action.name) を停止"
        }
    }

    /// The label of the hold-to-confirm control.
    public static func holdTitle(_ type: ShannonOpsCommandType) -> String {
        ShannonGeneratedStrings.opsConfirmHold(command: type == .scheduleRun ? "実行" : commandLabel(type))
    }

    /// Reads the common cron shapes (daily at a time, hourly, every n hours); anything else is shown as it arrived.
    public static func scheduleTime(_ time: String) -> String {
        let fields = time.split(whereSeparator: \.isWhitespace).map { $0 == "*/1" ? "*" : String($0) }
        guard fields.count == 5 else { return time }
        let (minuteField, hourField) = (fields[0], fields[1])
        guard fields[2] == "*", fields[3] == "*", fields[4] == "*",
              minuteField.count <= 2, minuteField.allSatisfy(\.isASCIIDigit),
              let minute = Int(minuteField), minute <= 59 else { return time }
        if hourField.count <= 2, hourField.allSatisfy(\.isASCIIDigit), let hour = Int(hourField), hour <= 23 {
            return ShannonGeneratedStrings.opsScheduleDaily(time: "\(hour):\(minute < 10 ? "0" : "")\(minute)")
        }
        if hourField == "*" { return ShannonGeneratedStrings.opsScheduleHourly(minute: String(minute)) }
        if hourField.hasPrefix("*/") {
            let every = hourField.dropFirst(2)
            if every.count <= 2, every.allSatisfy(\.isASCIIDigit), let hours = Int(every), (2...23).contains(hours) {
                return ShannonGeneratedStrings.opsScheduleEveryHours(hours: String(hours), minute: String(minute))
            }
        }
        return time
    }

    /// What a schedule row says about today, only when the report says it.
    public static func postedTodayLabel(_ postedToday: Bool?) -> String? {
        postedToday.map { $0 ? ShannonGeneratedStrings.opsSchedulePostedToday : ShannonGeneratedStrings.opsScheduleNotYetToday }
    }

    private static let refusals: [String: String] = [
        "OPS_COMMANDS_DISABLED": "操作は、いま本体の側で止められています。",
        "TARGET_NOT_ALLOWED": "その対象は、ここからは操作できません。",
        "OPS_STALE": "旧ランタイムからの報告が届いていないので、操作を受け付けられません。",
        "TARGET_UNKNOWN": "最新の報告に、その対象がありません。",
        "TOO_MANY_OPEN_COMMANDS": "結果を待っている操作が 5 件あります。終わってから、もう一度どうぞ。",
        "RATE_LIMITED": "操作が多すぎます（1 時間に 20 件まで）。少し待ってから、もう一度どうぞ。",
        "INVALID_REQUEST": "操作の内容が正しくありません。",
        "IDEMPOTENCY_KEY_REUSED": "同じ操作が、すでに別の内容で送られています。操作の記録を確かめてください。",
    ]

    /// Why the server did not take a command. Its own `message` is English and is not shown.
    public static func refusal(status: Int, code: String?) -> String {
        if let code, let known = refusals[code] { return known }
        if status == 401 { return ShannonGeneratedStrings.opsConnectionInvalid }
        return "操作が受け付けられませんでした（\(status)）。"
    }

    /// The request may or may not have arrived: pressing again could double it.
    public static let unknownDelivery = "サーバーへ届いたか分かりません。下の「操作の記録」を確かめてから、必要ならもう一度押してください。"
    public static let staleBeforeSending = "報告が古くなったので、送りませんでした。報告が届いてから、もう一度どうぞ。"
    public static let noLongerAllowed = "いまは、この操作を受け付けていません。送りませんでした。"
    public static let unreadableAnswer = "サーバーは受け取りましたが、応答を読み取れませんでした。操作の記録を確かめてください。"
    public static let notSentTitle = "送れませんでした"
    public static let unknownDeliveryTitle = "届いたか分かりません"
    public static let unreadableTitle = "応答を読み取れませんでした"
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
