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
            case .reaction: ShannonGeneratedStrings.yousuWaitingKindReaction
            case .decision: ShannonGeneratedStrings.yousuWaitingKindDecision
            case .approval: ShannonGeneratedStrings.yousuWaitingKindApproval
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
        let worded = (feeling.strength ?? 1) < 0.35 ? ShannonGeneratedStrings.yousuFeelingFaint(name: name) : name
        guard let since = feeling.startedAt.flatMap({ ShannonYousuTime.ago($0, now: now) }), since != "たったいま" else { return worded }
        return ShannonGeneratedStrings.yousuFeelingSince(feeling: worded, since: since)
    }

    // MARK: Her body

    public static func bodyLine(_ body: ShannonNowBodyDTO, now: Date = Date()) -> String {
        guard body.known else { return ShannonGeneratedStrings.yousuBodyUnknown }
        if body.present { return ShannonGeneratedStrings.yousuBodyPresent }
        guard let last = body.lastReadAt else { return ShannonGeneratedStrings.yousuBodyAbsent }
        return ShannonGeneratedStrings.yousuBodyAbsentSince(clock: ShannonYousuTime.clock(last, now: now))
    }

    public static func cameraLine(_ body: ShannonNowBodyDTO) -> String? {
        body.camera.map { ShannonGeneratedStrings.lookStateLine(state: $0 ? ShannonGeneratedStrings.lookStateAllowed : ShannonGeneratedStrings.lookStateOff) }
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
        case "seen": title = throughApp ? ShannonGeneratedStrings.yousuLookSeenThroughApp : ShannonGeneratedStrings.yousuLookSeenRoom
        case "looking": title = ShannonGeneratedStrings.yousuLookLooking
        case "refused": title = ShannonGeneratedStrings.yousuLookRefused
        case "discarded": title = ShannonGeneratedStrings.yousuLookDiscarded
        case "expired", "failed": title = ShannonGeneratedStrings.yousuLookFailed
        default: title = ShannonGeneratedStrings.yousuLookTried
        }
        let asked: String? = switch look.askedBy {
        case "owner": ShannonGeneratedStrings.yousuLookAskedByOwner
        case "herself": ShannonGeneratedStrings.yousuLookAskedByHerself
        default: nil
        }
        // After a look that happened, the refusal vocabulary has nothing to add.
        let reason = look.outcome == "seen" ? nil : look.code.flatMap { lookCodes[$0] } ?? (look.outcome == "expired" ? ShannonGeneratedStrings.yousuLookCodeTimeout : nil)
        let surface = throughApp && look.outcome != "seen" ? ShannonGeneratedStrings.yousuLookThroughApp : nil
        return ShannonNowEvent(id: "look-\(look.id)", kind: .look, at: look.at, title: title, detail: joined([asked, surface, reason]))
    }

    private static let lookCodes: [String: String] = [
        "camera_off": ShannonGeneratedStrings.yousuLookCodeCameraOff,
        "window_hidden": ShannonGeneratedStrings.yousuLookCodeWindowHidden,
        "busy": ShannonGeneratedStrings.yousuLookCodeBusy,
        "no_camera": ShannonGeneratedStrings.yousuLookCodeNoCamera,
        "denied": ShannonGeneratedStrings.yousuLookCodeDenied,
        "failed": ShannonGeneratedStrings.yousuLookCodeFailed,
        "timeout": ShannonGeneratedStrings.yousuLookCodeTimeout,
        "others_present": ShannonGeneratedStrings.yousuLookCodeOthersPresent,
        "rate_limited": ShannonGeneratedStrings.yousuLookCodeRateLimited,
        "model_failed": ShannonGeneratedStrings.yousuLookCodeModelFailed,
        "background": ShannonGeneratedStrings.yousuLookCodeBackground,
        "declined": ShannonGeneratedStrings.yousuLookCodeDeclined,
        "switched_off": ShannonGeneratedStrings.yousuLookCodeSwitchedOff,
        "interrupted": ShannonGeneratedStrings.yousuLookCodeInterrupted,
        "too_soon": ShannonGeneratedStrings.yousuLookCodeTooSoon,
    ]

    public static func event(_ touch: ShannonNowTouchDTO) -> ShannonNowEvent {
        // The server's own phrase when it knows the part (頬をつつかれた); otherwise the name of the kind.
        let name = touch.phrase.flatMap { $0.isEmpty ? nil : $0 } ?? touchKinds[touch.kind] ?? ShannonGeneratedStrings.yousuTouchOther
        let count = touch.count ?? 1
        return ShannonNowEvent(
            id: "touch-\(touch.id)", kind: .touch, at: touch.at,
            title: (count > 1 ? ShannonGeneratedStrings.yousuTouchCount(name: name, count: String(count)) : name) + (touch.place ?? ""),
            detail: touch.answered == true ? ShannonGeneratedStrings.yousuTouchAnswered : nil
        )
    }

    private static let touchKinds: [String: String] = [
        "pet": ShannonGeneratedStrings.yousuTouchPet, "tickle": ShannonGeneratedStrings.yousuTouchTickle, "poke": ShannonGeneratedStrings.yousuTouchPoke, "carry": ShannonGeneratedStrings.yousuTouchCarry, "holdHand": ShannonGeneratedStrings.yousuTouchHoldHand,
    ]

    public static func event(_ reachOut: ShannonNowReachOutDTO) -> ShannonNowEvent {
        let delivered = reachOut.deliveries.map(deliveryLabel)
        // The same wording twice (two bodies that both showed it) is said once.
        let unique = delivered.reduce(into: [String]()) { result, label in
            if !result.contains(label) { result.append(label) }
        }
        return ShannonNowEvent(
            id: "reach-out-\(reachOut.id)", kind: .reachOut, at: reachOut.at,
            title: reachOut.reason == "follow_up" ? ShannonGeneratedStrings.yousuReachOutFollowUp : ShannonGeneratedStrings.yousuReachOutSent,
            detail: unique.isEmpty ? ShannonGeneratedStrings.yousuReachOutDeliveryUnknown : unique.joined(separator: "・")
        )
    }

    /// How one message reached the owner on one surface. A surface or an outcome this app
    /// does not know is named as far as it can be, never guessed.
    public static func deliveryLabel(_ delivery: ShannonNowDeliveryDTO) -> String {
        switch (delivery.surface, delivery.outcome) {
        case ("body", "spoken"): ShannonGeneratedStrings.yousuDeliveryBodySpoken
        case ("body", "shown"): ShannonGeneratedStrings.yousuDeliveryBodyShown
        case ("body", "away"): ShannonGeneratedStrings.yousuDeliveryBodyAway
        case ("body", "hidden"): ShannonGeneratedStrings.yousuDeliveryBodyHidden
        case ("body", "muted"): ShannonGeneratedStrings.yousuDeliveryBodyMuted
        case ("body", _): ShannonGeneratedStrings.yousuDeliveryBody
        case ("app", "read"): ShannonGeneratedStrings.yousuDeliveryAppRead
        case ("app", "shown"): ShannonGeneratedStrings.yousuDeliveryAppShown
        case ("app", _): ShannonGeneratedStrings.yousuDeliveryApp
        case ("earphones", "spoken"):
            switch delivery.device {
            case "iphone": ShannonGeneratedStrings.yousuDeliveryEarphonesIphone
            case "mac": ShannonGeneratedStrings.yousuDeliveryEarphonesMac
            default: ShannonGeneratedStrings.yousuDeliveryEarphonesSpoken
            }
        case ("earphones", _): ShannonGeneratedStrings.yousuDeliveryEarphones
        case ("call", "answered"): ShannonGeneratedStrings.yousuDeliveryCallAnswered
        case ("call", "unanswered"): ShannonGeneratedStrings.yousuDeliveryCallUnanswered
        case ("call", "declined"): ShannonGeneratedStrings.yousuDeliveryCallDeclined
        case ("call", "failed"): ShannonGeneratedStrings.yousuDeliveryCallFailed
        case ("call", "ringing"): ShannonGeneratedStrings.yousuDeliveryCallRinging
        case ("call", _): ShannonGeneratedStrings.yousuDeliveryCall
        default: ShannonGeneratedStrings.yousuDeliveryOther
        }
    }

    /// 「今日」「昨日」「10月1日」 for the day header of the timeline.
    public static func dayTitle(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = ShannonYousuTime.date(iso) else { return ShannonGeneratedStrings.yousuDayUnknown }
        if calendar.isDate(date, inSameDayAs: now) { return ShannonGeneratedStrings.yousuDayToday }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return ShannonGeneratedStrings.yousuDayYesterday }
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
            return count > 0 ? ShannonGeneratedStrings.yousuWaitingSummaryPart(kind: kind.label, count: String(count)) : nil
        }.joined(separator: "・")
    }

    private static func joined(_ parts: [String?]) -> String? {
        let present = parts.compactMap { $0 }
        return present.isEmpty ? nil : present.joined(separator: "・")
    }
}
