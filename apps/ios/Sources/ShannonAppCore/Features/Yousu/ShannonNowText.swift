import Foundation

/// One line of the quiet timeline of 「シャノンのいま」: a look, a touch, or a message she started.
public struct ShannonNowEvent: Equatable, Identifiable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case look, touch, reachOut
    }

    public let id: String
    public let kind: Kind
    public let at: String
    public let title: String
    public let detail: String?

    public init(id: String, kind: Kind, at: String, title: String, detail: String? = nil) {
        self.id = id
        self.kind = kind
        self.at = at
        self.title = title
        self.detail = detail
    }

    public var symbolName: String {
        switch kind {
        case .look: "eye"
        case .touch: "hand.point.up.left"
        case .reachOut: "bubble.left"
        }
    }
}

/// Something that waits for the owner.
public struct ShannonNowWaitingItem: Equatable, Identifiable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        /// A story she showed and he has not reacted to.
        case reaction
        /// A proposal of hers, or a request for more budget today.
        case decision
        /// A work task that waits for a permission.
        case approval

        public var label: String {
            switch self {
            case .reaction: "感想"
            case .decision: "判断"
            case .approval: "許可"
            }
        }
    }

    public let id: String
    public let kind: Kind
    public let title: String
    public let detail: String

    public init(id: String, kind: Kind, title: String, detail: String) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
    }
}

/// The wording of 「シャノンのいま」. Neutral status text, never Shannon speaking. Every
/// vocabulary of the server may grow: an unknown word gets a neutral line or none, and
/// nothing here invents a reason the server did not give.
public enum ShannonNowText {
    // MARK: Feeling

    /// 「少しさみしい」 for a faint feeling; the name alone otherwise.
    public static func lingeringLabel(_ feeling: ShannonNowFaceDTO, now: Date = Date()) -> String? {
        guard let name = feeling.face?.japaneseName else { return nil }
        let worded = (feeling.strength ?? 1) < 0.35 ? "少し\(name)" : name
        guard let since = feeling.startedAt.flatMap({ ShannonYousuTime.ago($0, now: now) }), since != "たったいま" else { return worded }
        return "\(worded)（\(since)から）"
    }

    // MARK: Her body

    public static func bodyLine(_ body: ShannonNowBodyDTO, now: Date = Date()) -> String {
        guard body.known else { return "デスクトップの体のようすは、まだ届いていません" }
        if body.present { return "体はデスクトップに出ています" }
        guard let last = body.lastReadAt else { return "体はいま、デスクトップに出ていません" }
        return "体はいま、デスクトップに出ていません（最後は \(ShannonYousuTime.clock(last, now: now))）"
    }

    public static func cameraLine(_ body: ShannonNowBodyDTO) -> String? {
        body.camera.map { $0 ? "カメラ：見てよい" : "カメラ：切" }
    }

    // MARK: Timeline

    /// Looks, touches and messages she started, as one list, newest first.
    public static func timeline(_ now: ShannonNowDTO) -> [ShannonNowEvent] {
        let events = now.looks.map(event) + now.touches.map(event) + now.reachOuts.map(event)
        return events.sorted { left, right in
            switch (ShannonYousuTime.date(left.at), ShannonYousuTime.date(right.at)) {
            case let (leftDate?, rightDate?): leftDate > rightDate
            default: left.at > right.at
            }
        }
    }

    public static func event(_ look: ShannonNowLookDTO) -> ShannonNowEvent {
        let throughApp = look.surface == "app"
        let title: String
        switch look.outcome {
        case "seen": title = throughApp ? "アプリのカメラで見た" : "部屋を見た"
        case "looking": title = "見ているところ"
        case "refused": title = "見るのを断った"
        case "discarded": title = "見たものを使わなかった"
        case "expired", "failed": title = "見られなかった"
        default: title = "見ようとした"
        }
        let asked: String? = switch look.askedBy {
        case "owner": "あなたの頼み"
        case "herself": "シャノンが見たくなって"
        default: nil
        }
        // After a look that happened, the refusal vocabulary has nothing to add.
        let reason = look.outcome == "seen" ? nil : look.code.flatMap { lookCodes[$0] } ?? (look.outcome == "expired" ? "時間切れ" : nil)
        let surface = throughApp && look.outcome != "seen" ? "アプリのカメラ" : nil
        return ShannonNowEvent(id: "look-\(look.id)", kind: .look, at: look.at, title: title, detail: joined([asked, surface, reason]))
    }

    private static let lookCodes: [String: String] = [
        "camera_off": "カメラが切だった", "window_hidden": "体の窓が出ていなかった", "busy": "カメラがほかで使われていた",
        "no_camera": "カメラがなかった", "denied": "カメラの許可がなかった", "failed": "うまく撮れなかった", "timeout": "時間切れ",
        "others_present": "ほかの人がいた", "rate_limited": "見る回数の上限だった", "model_failed": "見たものを言葉にできなかった",
        "background": "アプリが前に出ていなかった", "declined": "今回は許可しなかった", "switched_off": "アプリのカメラが切だった",
        "interrupted": "話が先へ進んだ", "too_soon": "見たばかりだった",
    ]

    public static func event(_ touch: ShannonNowTouchDTO) -> ShannonNowEvent {
        // The server's own phrase when it knows the part (頬をつつかれた); otherwise the name of the kind.
        let name = touch.phrase.flatMap { $0.isEmpty ? nil : $0 } ?? touchKinds[touch.kind] ?? "触れられた"
        let count = touch.count ?? 1
        return ShannonNowEvent(
            id: "touch-\(touch.id)", kind: .touch, at: touch.at,
            title: (count > 1 ? "\(name)（\(count)回）" : name) + (touch.place ?? ""),
            detail: touch.answered == true ? "ひとこと返した" : nil
        )
    }

    private static let touchKinds: [String: String] = [
        "pet": "撫でられた", "tickle": "くすぐられた", "poke": "つつかれた", "carry": "抱えられた", "holdHand": "手をつないだ",
    ]

    public static func event(_ reachOut: ShannonNowReachOutDTO) -> ShannonNowEvent {
        let delivered = reachOut.deliveries.map(deliveryLabel)
        // The same wording twice (two bodies that both showed it) is said once.
        let unique = delivered.reduce(into: [String]()) { result, label in
            if !result.contains(label) { result.append(label) }
        }
        return ShannonNowEvent(
            id: "reach-out-\(reachOut.id)", kind: .reachOut, at: reachOut.at,
            title: reachOut.reason == "follow_up" ? "もう一度話しかけた" : "話しかけた",
            detail: unique.isEmpty ? "届き方は、まだ分かりません" : unique.joined(separator: "・")
        )
    }

    /// How one message reached the owner on one surface. A surface or an outcome this app
    /// does not know is named as far as it can be, never guessed.
    public static func deliveryLabel(_ delivery: ShannonNowDeliveryDTO) -> String {
        switch (delivery.surface, delivery.outcome) {
        case ("body", "spoken"): "体の声で届いた"
        case ("body", "shown"): "体に表示された"
        case ("body", "away"): "席を外していて、体では届かなかった"
        case ("body", "hidden"): "体の窓が出ていなくて、届かなかった"
        case ("body", "muted"): "体の「話しかける」が切で、届かなかった"
        case ("body", _): "体"
        case ("app", "read"): "トークで読んだ"
        case ("app", "shown"): "アプリに表示された"
        case ("app", _): "アプリ"
        case ("earphones", "spoken"):
            switch delivery.device {
            case "iphone": "イヤホンで届いた（iPhone）"
            case "mac": "イヤホンで届いた（Mac）"
            default: "イヤホンで届いた"
            }
        case ("earphones", _): "イヤホン"
        case ("call", "answered"): "電話で届いた"
        case ("call", "unanswered"): "電話に出なかった"
        case ("call", "declined"): "電話を断った"
        case ("call", "failed"): "電話がつながらなかった"
        case ("call", "ringing"): "電話を鳴らしているところ"
        case ("call", _): "電話"
        default: "ほかの方法"
        }
    }

    /// 「今日」「昨日」「10月1日」 for the day header of the timeline.
    public static func dayTitle(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = ShannonYousuTime.date(iso) else { return "日時不明" }
        if calendar.isDate(date, inSameDayAs: now) { return "今日" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "昨日" }
        return date.formatted(Date.FormatStyle(locale: Locale(identifier: "ja_JP"), calendar: calendar, timeZone: calendar.timeZone).month().day())
    }

    /// 「15:40」 in the device's time zone.
    public static func timeOfDay(_ iso: String, calendar: Calendar = .current) -> String {
        guard let date = ShannonYousuTime.date(iso) else { return "" }
        return date.formatted(Date.FormatStyle(locale: Locale(identifier: "ja_JP"), calendar: calendar, timeZone: calendar.timeZone).hour().minute())
    }

    // MARK: What waits for the owner

    /// 「感想 1・判断 1」: what kinds wait, in a fixed order.
    public static func waitingSummary(_ items: [ShannonNowWaitingItem]) -> String {
        let kinds: [ShannonNowWaitingItem.Kind] = [.reaction, .decision, .approval]
        return kinds.compactMap { kind in
            let count = items.filter { $0.kind == kind }.count
            return count > 0 ? "\(kind.label) \(count)" : nil
        }.joined(separator: "・")
    }

    private static func joined(_ parts: [String?]) -> String? {
        let present = parts.compactMap { $0 }
        return present.isEmpty ? nil : present.joined(separator: "・")
    }
}
