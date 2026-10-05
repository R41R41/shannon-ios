import Foundation

/// The form Shannon's figure takes in this app. A per-device setting: the owner chooses it in
/// Talk's display options or in 設定 › すがた, and every place her figure is the subject follows it.
public enum ShannonForm: String, CaseIterable, Identifiable, Sendable {
    /// The Waterlight Eye, drawn natively. The default, and the fallback whenever Live2D is not showing.
    case waterlight
    /// The Live2D character, drawn by the bundled embed page in one shared web view.
    case live2d

    public static let storageKey = "shannon.body.form"

    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .waterlight: "水の光の目"
        case .live2d: "Live2Dの姿"
        }
    }

    public static func current(defaults: UserDefaults = .standard) -> ShannonForm {
        defaults.string(forKey: storageKey).flatMap(ShannonForm.init(rawValue:)) ?? .waterlight
    }
}

/// Which body the Live2D form shows (owner decision 2026-10-05, the same choice as 設定 › すがた › 体 on the
/// desktop): the character (the default) or her eyes alone, two light-blue eyes that move as the Waterlight Eye does.
/// A per-device setting with a meaning only in the Live2D form; the embed page switches with `setBody`.
public enum ShannonLive2DBody: String, CaseIterable, Identifiable, Sendable {
    case human
    case eyes

    public static let storageKey = "shannon.body.live2d-body"

    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .human: ShannonGeneratedStrings.settingsFigureBodyHuman
        case .eyes: ShannonGeneratedStrings.settingsFigureBodyEyes
        }
    }

    /// What the eyes are, under the choice; the character needs no words.
    public var explanation: String? {
        switch self {
        case .human: nil
        case .eyes: ShannonGeneratedStrings.settingsFigureBodyEyesHint
        }
    }

    /// The body has a mouth, arms and a framing of its own (全身／上半身). The eyes have none of them: lip sync,
    /// gestures and the calm of idle movement do nothing there, and only the size and the place of the layout count.
    public var hasCharacterRig: Bool { self == .human }

    public static func current(defaults: UserDefaults = .standard) -> ShannonLive2DBody {
        defaults.string(forKey: storageKey).flatMap(ShannonLive2DBody.init(rawValue:)) ?? .human
    }
}

/// The owner's switches for her body in this app.
public enum ShannonBodyPreference {
    /// 「体に起きたことをシャノンに伝える」. Off by default, as on Windows: touches then animate
    /// locally and nothing leaves the device.
    public static let reportsTouchKey = "shannon.body.reports-touch"

    public static func reportsTouch(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: reportsTouchKey)
    }

    /// 映し方 (全身／上半身) of the Live2D figure in Talk (and of the Mac's body sheet). The key the body screen used.
    public static let layoutModeKey = "shannon.body.layout-mode"
}

/// Every sentence of her figure in Talk, the 「すがた」 settings section and the Mac's body sheet.
public enum ShannonBodyCopy {
    public static let sectionTitle = ShannonGeneratedStrings.settingsFigure
    public static let formTitle = ShannonGeneratedStrings.settingsFigure
    public static let formHint = ShannonGeneratedStrings.settingsFigureFormHint
    /// 設定 › すがた on the iPhone: opens Talk's dialogue display (「向き合う」), where her figure is.
    public static let showInTalk = ShannonGeneratedStrings.settingsFigureShowInTalk
    public static let showInTalkHint = ShannonGeneratedStrings.settingsFigureShowInTalkHint
    /// The display button of Talk: one tap switches the display, a long press offers her figure's options.
    public static let displayMenuHint = ShannonGeneratedStrings.talkDisplayMenuHint
    public static let reportsTouchTitle = "体に起きたことをシャノンに伝える"
    public static let reportsTouchHint = "オンにすると、Live2Dの姿に触れたことがシャノンに届きます"
    public static let settingsExplanation = touchWaysHuman + touchPrivacy
    /// How she can be touched, by body: the eyes can only be poked.
    static let touchWaysHuman = "Live2Dの姿は指で触れられます（頭をなでる、つつく、くすぐる、手をつなぐ）。"
    static let touchPrivacy = "「体に起きたことをシャノンに伝える」がオフの間は、この端末の中で動くだけで、何も送りません。オンにすると、触れた種類・長さ・強さ・時刻だけがシャノンに届き、気持ちが動いて、ひとこと返すことがあります。カメラは使いません。"
    public static func settingsExplanation(body: ShannonLive2DBody) -> String {
        (body == .eyes ? ShannonGeneratedStrings.settingsFigureTouchEyes : touchWaysHuman) + touchPrivacy + touchOnThisDevice
    }
    /// The Mac says who a touch reaches as: only when he switched it on, and as from him alone, since the Mac
    /// has no switch yet for other people being near (A15).
    static var touchOnThisDevice: String {
#if os(macOS)
        ShannonGeneratedStrings.settingsFigureTouchMac
#else
        ""
#endif
    }
    /// 体 (人の姿／目だけ): in 設定 › すがた, Talk's display options and the Mac's body sheet.
    public static let bodyTitle = ShannonGeneratedStrings.settingsFigureBody
    public static let bodyOnlyLive2D = ShannonGeneratedStrings.settingsFigureBodyOnlyLive2D
    public static let bodyEyesUnavailable = ShannonGeneratedStrings.settingsFigureBodyEyesUnavailable
    /// Why 体 cannot be chosen now, or nothing when it can.
    @MainActor public static func bodyUnavailableReason(usesLive2D: Bool) -> String? {
        !usesLive2D ? bodyOnlyLive2D : ShannonLive2DStage.shared.offersEyes ? nil : bodyEyesUnavailable
    }
    public static let layoutOnlyHuman = ShannonGeneratedStrings.settingsFigureLayoutOnlyHuman
    public static let replyModeTitle = "触れたときの返事"
    public static let replyModeExplanation = ShannonGeneratedStrings.settingsFigureReplyModeExplanation
    public static let layoutTitle = "映し方"
    public static let layoutFull = "全身"
    public static let layoutBust = "上半身"
    public static let resetLayout = "位置を戻す"
    public static let gestureHint = "2本の指で、大きさと位置を変えられます"
    public static let loading = "Live2Dの姿を読み込んでいます…"
    /// 「Live2Dの姿を読み込んでいます… 40%」 once the page reports how far it is.
    public static func loading(progress: Double) -> String {
        progress > 0 ? "\(loading) \(Int((min(1, max(0, progress)) * 100).rounded()))%" : loading
    }
    public static let failed = "Live2Dの姿を表示できませんでした。水の光の目で表示しています。"
    public static let shownElsewhere = "Live2Dの姿は、いま別の画面に出ています。ここでは水の光の目で表示しています。"
    public static let layoutOnlyLive2D = ShannonGeneratedStrings.settingsFigureLayoutOnlyLive2D
    public static let retry = "もう一度読み込む"
    public static let resting = "省電力のため、動きを止めています。触れると動きます"
    public static let restingReduceMotion = "視差効果を減らす設定のため、動きを止めています。触れると動きます"
    public static let unavailable = "この版にはLive2Dの姿が入っていません。水の光の目で表示しています。"
    public static let touchNotConnected = "シャノンに接続すると、触れたことを伝えられます"
    public static let touchNotDelivered = "触れたことを伝えられませんでした。次に触れたときにもう一度送ります"
    public static let touchUnsupported = "サーバーが未対応のため、触れたことは伝わりません"
    public static let touchOthers = "「友人も一緒」の間は、ほかの人もいる時のこととして伝えます"
    public static let figureDirectHint = "Live2Dの姿。この上では指がそのまま届きます。上下のスワイプで大きさを変えられます"
    public static let figureHint = "Live2Dの姿。指で触れられます"
    /// The small figure of an empty Talk in the Live2D form: it opens the dialogue display, where she can be touched.
    public static let heroHint = ShannonGeneratedStrings.talkFigureHeroHint

    /// 「いま：〈気持ち〉・〈していること〉」: one quiet line under her figure.
    public static func nowLine(face: ShannonFace, doing: String?) -> String {
        ["いま：\(face.japaneseName)", doing].compactMap { $0 }.joined(separator: "・")
    }
}
