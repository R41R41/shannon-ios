import Foundation

/// Bounded autonomy (Syzygy ADR-0002) as the owner sees it. The server is the
/// authority for every value here; clients only present it and carry the owner's
/// decisions back. Raw strings are kept for values a newer server may extend.

public struct ShannonAutonomyControlDTO: Codable, Equatable, Sendable {
    /// `disabled` (server switch off), `paused` (owner's stop switch), or `active`.
    public let state: String
    public let enabled: Bool
    public let paused: Bool
    public let changedAt: String?

    public init(state: String, enabled: Bool, paused: Bool, changedAt: String? = nil) {
        self.state = state
        self.enabled = enabled
        self.paused = paused
        self.changedAt = changedAt
    }

    public var stateLabel: String {
        if !enabled { return "準備中" }
        return paused ? "一時停止中" : "動いてよい状態"
    }

    public var stateDetail: String {
        if !enabled { return "自分から動く仕組みは、まだサーバーで有効になっていません。" }
        return paused
            ? "シャノンは自分からは何もしません。会話・音声・記憶・あなたが始めた作業は、これまでどおり動きます。"
            : "決められた範囲と予算の中で、シャノンが自分から動けます。"
    }

    public var symbolName: String {
        if !enabled { return "moon.zzz" }
        return paused ? "pause.circle" : "play.circle"
    }
}

public struct ShannonAutonomyBudgetDTO: Codable, Equatable, Sendable {
    public let dayKey: String
    public let baseCapYen: Double
    public let extraYen: Double
    public let capYen: Double
    public let spentYen: Double
    public let remainingYen: Double
    public let exhausted: Bool
    public let yenPerUsd: Double

    public init(
        dayKey: String, baseCapYen: Double, extraYen: Double, capYen: Double,
        spentYen: Double, remainingYen: Double, exhausted: Bool, yenPerUsd: Double
    ) {
        self.dayKey = dayKey
        self.baseCapYen = baseCapYen
        self.extraYen = extraYen
        self.capYen = capYen
        self.spentYen = spentYen
        self.remainingYen = remainingYen
        self.exhausted = exhausted
        self.yenPerUsd = yenPerUsd
    }

    public var usedLabel: String {
        "\(ShannonAutonomyFormat.yen(spentYen)) / \(ShannonAutonomyFormat.yen(capYen))"
    }

    public var fraction: Double {
        capYen > 0 ? min(1, max(0, spentYen / capYen)) : 1
    }
}

public struct ShannonAutonomyBudgetRequestDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let dayKey: String
    public let reason: String
    public let requestedYen: Double
    /// `pending`, `approved`, or `declined`.
    public let status: String
    public let approvedYen: Double
    public let createdAt: String
    public let decidedAt: String?

    public init(
        id: String, dayKey: String, reason: String, requestedYen: Double, status: String,
        approvedYen: Double = 0, createdAt: String, decidedAt: String? = nil
    ) {
        self.id = id
        self.dayKey = dayKey
        self.reason = reason
        self.requestedYen = requestedYen
        self.status = status
        self.approvedYen = approvedYen
        self.createdAt = createdAt
        self.decidedAt = decidedAt
    }

    public var isPending: Bool { status == "pending" }

    public var statusLabel: String {
        switch status {
        case "approved": "今日だけ\(ShannonAutonomyFormat.yen(approvedYen))増やしました"
        case "declined": "見送りました"
        default: "あなたの返事を待っています"
        }
    }
}

public struct ShannonPursuitLinkDTO: Codable, Equatable, Sendable {
    public let label: String
    public let url: String
}

public struct ShannonPursuitDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    /// `goal`, `question`, or `work`.
    public let kind: String
    public let title: String
    public let why: String
    /// `active`, `resting`, `done`, or `dropped`.
    public let status: String
    /// `seed`, `conversation`, or `self`.
    public let origin: String
    public let links: [ShannonPursuitLinkDTO]
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String, kind: String, title: String, why: String, status: String, origin: String,
        links: [ShannonPursuitLinkDTO] = [], createdAt: String, updatedAt: String
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.why = why
        self.status = status
        self.origin = origin
        self.links = links
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var isSeed: Bool { origin == "seed" }
    public var isOpen: Bool { status == "active" || status == "resting" }
    /// The owner may only tell her to rest or drop an entry that is hers and still open.
    public var ownerCanRest: Bool { !isSeed && status == "active" }
    public var ownerCanDrop: Bool { !isSeed && isOpen }

    public var kindLabel: String {
        switch kind {
        case "goal": "目標"
        case "question": "問い"
        default: "作品"
        }
    }

    public var kindSymbol: String {
        switch kind {
        case "goal": "flag"
        case "question": "questionmark.circle"
        default: "pencil.and.outline"
        }
    }

    public var statusLabel: String {
        switch status {
        case "active": "続けている"
        case "resting": "休ませている"
        case "done": "やり終えた"
        case "dropped": "やめた"
        default: "状態を確認中"
        }
    }

    public var originLabel: String {
        switch origin {
        case "seed": "はじめに決めたこと"
        case "conversation": "会話から"
        default: "シャノンが自分で"
        }
    }
}

public struct ShannonAutonomyModelChoiceDTO: Codable, Equatable, Identifiable, Sendable {
    public let purpose: String
    public let purposeLabel: String
    public let modelId: String
    public let modelLabel: String
    /// `shannon` when she chose it, `default` otherwise.
    public let chosenBy: String
    public let reason: String?
    public let recommendation: String?
    public let updatedAt: String?

    public var id: String { purpose }
    public var chosenByLabel: String { chosenBy == "shannon" ? "シャノンが選択" : "既定" }
}

public struct ShannonAutonomyProposalDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let origin: String
    public let title: String
    public let goal: String
    public let reason: String
    public let projectHint: String?
    public let coreAreaLabels: [String]?
    /// `proposed`, `started`, or `declined`.
    public let status: String
    public let taskId: String?
    public let createdAt: String
    public let decidedAt: String?

    public init(
        id: String, origin: String = "shannon", title: String, goal: String, reason: String,
        projectHint: String? = nil, coreAreaLabels: [String]? = nil, status: String,
        taskId: String? = nil, createdAt: String, decidedAt: String? = nil
    ) {
        self.id = id
        self.origin = origin
        self.title = title
        self.goal = goal
        self.reason = reason
        self.projectHint = projectHint
        self.coreAreaLabels = coreAreaLabels
        self.status = status
        self.taskId = taskId
        self.createdAt = createdAt
        self.decidedAt = decidedAt
    }

    public var isWaiting: Bool { status == "proposed" }

    public var statusLabel: String {
        switch status {
        case "started": "開始済み"
        case "declined": "見送り"
        default: "あなたの判断待ち"
        }
    }

    public var coreAreaSummary: String? {
        guard let labels = coreAreaLabels, !labels.isEmpty else { return nil }
        return "基幹部分：" + labels.joined(separator: "・")
    }
}

public struct ShannonAutonomyOverviewDTO: Codable, Equatable, Sendable {
    public let control: ShannonAutonomyControlDTO
    /// The activity loop's state line. Absent from a server that has no loop yet.
    public let loop: ShannonAutonomyLoopDTO?
    public let budget: ShannonAutonomyBudgetDTO
    public let budgetRequest: ShannonAutonomyBudgetRequestDTO?
    public let maximumExtraYen: Double
    public let pursuits: [ShannonPursuitDTO]
    public let modelChoices: [ShannonAutonomyModelChoiceDTO]
    public let proposals: [ShannonAutonomyProposalDTO]

    public init(
        control: ShannonAutonomyControlDTO,
        loop: ShannonAutonomyLoopDTO? = nil,
        budget: ShannonAutonomyBudgetDTO,
        budgetRequest: ShannonAutonomyBudgetRequestDTO? = nil,
        maximumExtraYen: Double = 0,
        pursuits: [ShannonPursuitDTO] = [],
        modelChoices: [ShannonAutonomyModelChoiceDTO] = [],
        proposals: [ShannonAutonomyProposalDTO] = []
    ) {
        self.control = control
        self.loop = loop
        self.budget = budget
        self.budgetRequest = budgetRequest
        self.maximumExtraYen = maximumExtraYen
        self.pursuits = pursuits
        self.modelChoices = modelChoices
        self.proposals = proposals
    }

    /// 準備中／動いています／一時停止中／今日は予算を使い切りました, or the switch state from an older server.
    public var stateLabel: String { loop?.label ?? control.stateLabel }
    public var stateDetail: String { loop?.detail ?? control.stateDetail }
    public var stateSymbol: String { loop?.symbolName ?? control.symbolName }
}

public struct ShannonAutonomyActivityEntryDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let occurredAt: String
    public let dayKey: String
    public let kind: String
    /// `shannon` or `owner`.
    public let actor: String
    public let summary: String
    public let detail: String?
    public let domain: String
    public let domainLabel: String
    public let model: String?
    public let tool: String?
    public let costYen: Double
    public let outcome: String
    public let link: String?
    /// `not_needed`, `needed`, `approved`, or `declined`.
    public let approval: String

    public init(
        id: String, occurredAt: String, dayKey: String, kind: String, actor: String, summary: String,
        detail: String? = nil, domain: String, domainLabel: String, model: String? = nil, tool: String? = nil,
        costYen: Double = 0, outcome: String, link: String? = nil, approval: String = "not_needed"
    ) {
        self.id = id
        self.occurredAt = occurredAt
        self.dayKey = dayKey
        self.kind = kind
        self.actor = actor
        self.summary = summary
        self.detail = detail
        self.domain = domain
        self.domainLabel = domainLabel
        self.model = model
        self.tool = tool
        self.costYen = costYen
        self.outcome = outcome
        self.link = link
        self.approval = approval
    }

    /// The piece of her study this entry produced, when it produced one.
    public var studyPieceID: String? {
        guard let link, link.hasPrefix("shannon-study://") else { return nil }
        let id = String(link.dropFirst("shannon-study://".count))
        return id.isEmpty ? nil : id
    }

    public var outcomeLabel: String {
        switch outcome {
        case "allowed": "許可"
        case "needs_approval": "承認が必要"
        case "refused": "止めた"
        case "done": "した"
        case "failed": "うまくいかなかった"
        case "paused": "一時停止"
        case "resumed": "再開"
        case "requested": "お願い"
        case "approved": "承認"
        case "declined": "見送り"
        default: "記録"
        }
    }

    public var symbolName: String {
        switch outcome {
        case "allowed", "done": "checkmark.circle"
        case "needs_approval", "requested": "hand.raised"
        case "refused": "nosign"
        case "failed": "exclamationmark.triangle"
        case "paused": "pause.circle"
        case "resumed": "play.circle"
        case "approved": "checkmark.seal"
        case "declined": "xmark.circle"
        default: "doc.text"
        }
    }

    public var approvalLabel: String? {
        switch approval {
        case "needed": "承認待ち"
        case "approved": "承認済み"
        case "declined": "見送り"
        default: nil
        }
    }

    /// Who, where, with what, and for how much, on one line.
    public var metadataLine: String {
        var parts = [actor == "owner" ? "あなた" : "シャノン", domainLabel, outcomeLabel]
        if let approvalLabel, approvalLabel != outcomeLabel { parts.append(approvalLabel) }
        if let model { parts.append(model) }
        if let tool { parts.append(tool) }
        if costYen > 0 { parts.append(ShannonAutonomyFormat.yen(costYen)) }
        return parts.joined(separator: " ・ ")
    }
}

public struct ShannonAutonomyActivityDayDTO: Codable, Equatable, Identifiable, Sendable {
    public let dayKey: String
    public let summary: String
    public let costYen: Double
    public let entries: [ShannonAutonomyActivityEntryDTO]

    public var id: String { dayKey }

    public init(dayKey: String, summary: String, costYen: Double = 0, entries: [ShannonAutonomyActivityEntryDTO]) {
        self.dayKey = dayKey
        self.summary = summary
        self.costYen = costYen
        self.entries = entries
    }
}

public struct ShannonAutonomyActivityDTO: Codable, Equatable, Sendable {
    public let control: ShannonAutonomyControlDTO
    public let loop: ShannonAutonomyLoopDTO?
    /// Today's spend against the cap, as of this reading of the record.
    public let budget: ShannonAutonomyBudgetDTO?
    public let days: [ShannonAutonomyActivityDayDTO]

    public init(
        control: ShannonAutonomyControlDTO, loop: ShannonAutonomyLoopDTO? = nil,
        budget: ShannonAutonomyBudgetDTO? = nil, days: [ShannonAutonomyActivityDayDTO]
    ) {
        self.control = control
        self.loop = loop
        self.budget = budget
        self.days = days
    }
}

struct ShannonAutonomyPauseRequestDTO: Codable, Equatable, Sendable {
    let scopeKey: String
    let paused: Bool
}

struct ShannonAutonomyBudgetDecisionRequestDTO: Codable, Equatable, Sendable {
    let scopeKey: String
    let decision: String
    let amountYen: Double?
}

struct ShannonAutonomyStatusRequestDTO: Codable, Equatable, Sendable {
    let scopeKey: String
    let status: String
}

struct ShannonAutonomyDecisionRequestDTO: Codable, Equatable, Sendable {
    let scopeKey: String
    let decision: String
}

public enum ShannonAutonomyFormat {
    /// `1,000円`, or two decimals when the amount is not whole.
    public static func yen(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        let whole = rounded == rounded.rounded()
        return rounded.formatted(
            .number.grouping(.automatic).precision(.fractionLength(whole ? 0 : 2)).locale(Locale(identifier: "ja_JP"))
        ) + "円"
    }

    /// `10月2日（金）` from an owner-local `YYYY-MM-DD` day key.
    public static func dayTitle(_ dayKey: String) -> String {
        let parts = dayKey.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return dayKey }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        guard let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else {
            return dayKey
        }
        let weekday = ["日", "月", "火", "水", "木", "金", "土"][calendar.component(.weekday, from: date) - 1]
        return "\(parts[1])月\(parts[2])日（\(weekday)）"
    }

    /// Clock time of an entry in the device's time zone.
    public static func time(_ iso: String) -> String {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        guard let date = (try? fractional.parse(iso)) ?? (try? Date.ISO8601FormatStyle().parse(iso)) else { return "" }
        return date.formatted(.dateTime.hour().minute().locale(Locale(identifier: "ja_JP")))
    }
}
