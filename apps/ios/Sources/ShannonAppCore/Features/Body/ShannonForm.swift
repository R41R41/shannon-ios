import Foundation

/// The form Shannon's figure takes in this app. A per-device setting: the owner chooses it on
/// the body screen or in Settings, and every place her figure is the subject follows it.
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

/// The owner's switches for her body in this app.
public enum ShannonBodyPreference {
    /// 「体に起きたことをシャノンに伝える」. Off by default, as on Windows: touches then animate
    /// locally and nothing leaves the device.
    public static let reportsTouchKey = "shannon.body.reports-touch"

    public static func reportsTouch(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: reportsTouchKey)
    }
}

/// Every sentence of the body screen and the 「すがた」 settings section.
public enum ShannonBodyCopy {
    public static let screenTitle = "からだ"
    public static let sectionTitle = "すがた"
    public static let formTitle = "すがた"
    public static let formHint = "会話と音声会話、からだの画面でのシャノンの姿を切り替えます"
    public static let openScreenTitle = "からだを開く"
    public static let reportsTouchTitle = "体に起きたことをシャノンに伝える"
    public static let reportsTouchHint = "オンにすると、Live2Dの姿に触れたことがシャノンに届きます"
    public static let settingsExplanation = "Live2Dの姿は指で触れられます（頭をなでる、つつく、くすぐる、手をつなぐ）。「体に起きたことをシャノンに伝える」がオフの間は、この端末の中で動くだけで、何も送りません。オンにすると、触れた種類・長さ・強さ・時刻だけがシャノンに届き、気持ちが動いて、ひとこと返すことがあります。カメラは使いません。"
    public static let macExplanation = "Live2Dの姿は「からだを開く」で見られます。このMacからは、触れたことをシャノンに伝えません。"
    public static let replyModeTitle = "触れたときの返事"
    public static let replyModeExplanation = "「声で返す」では、触れたときのひとことをシャノンが声に出して言い、そのあと数秒だけマイクを開いて返事を聞きます。ほかの人がいる時と、通話や読み上げの最中は、文字だけで返します。"
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
    public static let openBodyHint = "からだの画面を開きます"

    /// 「いま：〈気持ち〉・〈していること〉」: one quiet line under her figure.
    public static func nowLine(face: ShannonFace, doing: String?) -> String {
        ["いま：\(face.japaneseName)", doing].compactMap { $0 }.joined(separator: "・")
    }
}
