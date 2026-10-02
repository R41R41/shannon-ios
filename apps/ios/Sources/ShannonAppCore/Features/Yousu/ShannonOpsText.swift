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
        case .running: "動いている"
        case .stopped: "止まっている"
        case .degraded: "不調"
        case .unknown: "不明"
        }
    }

    /// The same state in a report that is no longer current: never worded as the present.
    public static func staleStatusLabel(_ status: ShannonOpsStatus) -> String {
        switch status {
        case .running: "動いていた"
        case .stopped: "止まっていた"
        case .degraded: "不調だった"
        case .unknown: "不明"
        }
    }

    private static let serviceNames: [String: String] = [
        "discord": "Discord", "minebot": "Minebot（管理側）", "minebot:bot": "Minebot の体", "minecraft": "Minecraft",
        "notion": "Notion", "youtube": "YouTube", "youtube:live_chat": "YouTube ライブチャット",
        "twitter": "X（Twitter）", "x": "X（Twitter）", "line": "LINE", "web": "Web",
    ]

    public static func serviceName(id: String, label: String) -> String {
        if let known = serviceNames[id] { return known }
        if id.hasPrefix(minecraftPrefix) { return "Minecraft サーバー \(id.dropFirst(minecraftPrefix.count))" }
        return !label.isEmpty && label != id ? label : id
    }

    public static func serviceName(_ service: ShannonOpsServiceDTO) -> String {
        serviceName(id: service.id, label: service.label)
    }

    public static func commandLabel(_ type: ShannonOpsCommandType) -> String {
        switch type {
        case .serviceStart, .minecraftStart: "開始"
        case .serviceStop, .minecraftStop: "停止"
        case .scheduleRun: "今すぐ実行"
        case .minebotStart: "起動"
        }
    }

    public static func commandStatusLabel(_ status: ShannonOpsCommandStatus) -> String {
        switch status {
        case .pending: "実行待ち"
        case .claimed: "実行中"
        case .done: "完了"
        case .failed: "失敗"
        case .refused: "断られました"
        case .expired: "期限切れ"
        case .unknown: "不明"
        }
    }

    private static let codeLabels: [String: String] = [
        "not_registered": "旧ランタイムに、その対象がありませんでした",
        "already_running": "すでに動いていました",
        "already_stopped": "すでに止まっていました",
        "busy": "同じ対象の、ほかの操作が進行中でした",
        "lab_running": "ラボの実走中のため、Minecraft サーバーを起動しませんでした",
        "timeout": "時間内に終わりませんでした",
        "error": "失敗しました（理由は、旧ランタイムのログにあります）",
        "unsupported": "旧ランタイムが、この操作に対応していません",
        "not_allowed": "旧ランタイムの側で、許可されていない対象でした",
        "no_report": "結果が届きませんでした（実行されたかどうかは、状態を見て確かめてください）",
    ]

    /// For starting the Minebot body the same words mean something else (server contract).
    private static let minebotStartCodeLabels: [String: String] = [
        "already_stopped": "選んだ Minecraft サーバーが止まっていたので、起動しませんでした",
        "already_running": "Minebot の体は、すでに動いていました",
        "lab_running": "ラボの実走中のため、Minebot の体を起動しませんでした",
        "not_registered": "サーバーか、Minebot の体の状態を取れませんでした",
    ]

    /// The reason of a result. A word this app does not know is shown as it arrived.
    public static func commandCodeLabel(_ code: String, type: ShannonOpsCommandType? = nil) -> String {
        (type == .minebotStart ? minebotStartCodeLabels[code] : nil) ?? codeLabels[code] ?? code
    }

    /// The reason shown beside a finished command: its code, or what an expiry means.
    public static func commandReason(_ command: ShannonOpsCommandDTO) -> String? {
        if let code = command.code { return commandCodeLabel(code, type: command.type) }
        return command.status == .expired ? "5 分以内に受け取られなかったので、実行していません" : nil
    }

    public static func commandTargetName(type: ShannonOpsCommandType, target: String) -> String {
        if type == .scheduleRun { return "予定「\(target)」" }
        let name = serviceName(id: target, label: target)
        return type == .minebotStart ? "Minebot の体（\(name) に入る）" : name
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
                "予定「\(name)」を、いますぐ実行しますか？",
                "",
                "実行すると、この予定の処理がいま動き、実際に公開の場（X（Twitter）や YouTube など）へ投稿・返信されます。取り消せません。",
                postedToday == true
                    ? "今日は、すでに投稿済みです。実行すると、もう一度投稿されます。"
                    : "今日すでに投稿済みの場合でも、もう一度投稿されます。",
            ].joined(separator: "\n")
        case .minebotStart:
            // These two sentences are a promise to the owner (2026-10-02). The wording does not change.
            return [
                "Minebot の体を、\(name) に入らせて起動しますか？",
                "",
                "起動すると、課金つきの計画機能が動き始めます。止めるまで費用がかかります。この画面には費用は表示されません。",
                "いま動くのは、ラボでネザーに到達した版より古い版です。",
            ].joined(separator: "\n")
        case .serviceStop, .minecraftStop:
            return "\(name) を停止しますか？\n\n止めている間、この機能は動きません（もう一度動かすには、ここから開始します）。"
        case .serviceStart, .minecraftStart:
            return "\(name) を開始しますか？"
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
        type == .scheduleRun ? "長押しで実行" : "長押しで\(commandLabel(type))"
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
            return "毎日 \(hour):\(minute < 10 ? "0" : "")\(minute)"
        }
        if hourField == "*" { return "毎時 \(minute) 分" }
        if hourField.hasPrefix("*/") {
            let every = hourField.dropFirst(2)
            if every.count <= 2, every.allSatisfy(\.isASCIIDigit), let hours = Int(every), (2...23).contains(hours) {
                return "\(hours) 時間ごと（\(minute) 分）"
            }
        }
        return time
    }

    /// What a schedule row says about today, only when the report says it.
    public static func postedTodayLabel(_ postedToday: Bool?) -> String? {
        postedToday.map { $0 ? "今日は投稿済み" : "今日はまだ" }
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
        if status == 401 { return "接続が無効になりました。もう一度接続してください。" }
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
