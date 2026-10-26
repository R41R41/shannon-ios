import Foundation

/// Wording of the earphone settings. Neutral status text, not Shannon's voice.
public enum ShannonPrivateListeningCopy {
    public static let sectionTitle = "イヤホン"
    public static let currentOutputTitle = "いまの音の出口"
    public static let noOutput = "見つかりません"
    public static let statusTitle = "シャノンへの連絡"
    public static let registeredTitle = "登録したイヤホン"
    public static let removeTitle = "登録を解除"
    public static let explanation = "登録したイヤホンか有線のヘッドホンから音が出ている間だけ、「自分だけに聞こえる」状態としてシャノンに伝えます。"
        + "Bluetoothの機器はイヤホンとスピーカーを区別できないため、自分のイヤホンをつないだ状態で登録してください。"
        + "有線の出口は、つないだ先がスピーカーでもヘッドホンとして扱われます。イヤホンジャックにスピーカーをつないでいる場合は「有線の出口をヘッドホンとして扱う」をオフにしてください。"
        + "登録はこの端末にだけ保存し、機器の名前はサーバーへ送りません。"
    public static let wiredTitle = "有線の出口をヘッドホンとして扱う"
    public static let wiredHint = "オフにすると、有線でつないだ出口を「自分だけに聞こえる」として扱いません。イヤホンジャックにスピーカーをつないでいる場合はオフにしてください"
    public static let speaksUnavailable = "サーバー側で声での話しかけが止められています"

    public static let speaksTitle = "イヤホンのときは声で話しかける"
    public static let speaksHint = "オンにすると、登録したイヤホンか有線のヘッドホンから音が出ている間、シャノンが自分から声で話しかけます"
    public static let speaksExplanation = "オンにすると、自分だけに聞こえる間、シャノンが自分から話しかけるときに声でも伝えます。"
        + "話し終えたあと数秒だけマイクを開き、返事があれば会話として保存します。返事がなければ何も保存しません。"
        + "スピーカーや未登録の機器からは声を出しません。最初はオフです。"
    public static let microphoneDenied = "マイクが許可されていないため、話しかけたあとの返事は聞き取れません。"

    public static let standbyTitle = "ほかのアプリを使っている間も待機する"
    public static let standbyHint = "オンにすると、登録したイヤホンをつないでいる間、アプリを閉じても音声の接続を保ちます。電池を多く使います"
    public static let standbyExplanation = "オンにすると、登録したイヤホンをつないでいる間、ほかのアプリを使っていても音声の接続を保ち、シャノンが声で話しかけられるようにします。"
        + "そのぶん電池を多く使います。最初はオフです。省電力モード中は待機しません。"
        + "イヤホンを外すと待機は止まり、もう一度つないだあとはこのアプリを開くと再開します。"
        + "アプリを上にスワイプして終了したときも待機は止まります。"
        + "話しかけたあとの数秒間はマイクを使うため、画面の上にマイク使用中の表示が出ます。"
    /// The footer of the speaking rows: the iPhone adds its standby.
    public static var speakingExplanation: String {
#if os(macOS)
        speaksExplanation
#else
        speaksExplanation + "\n\n" + standbyExplanation
#endif
    }

    public static func speaksStatus(enabled: Bool, speaksNow: Bool, serverDelivers: Bool = true) -> String {
        if !enabled { return "オフ" }
        guard speaksNow else { return "イヤホンをつなぐと話しかけます" }
        return serverDelivers ? "いま声で話しかけられます" : speaksUnavailable
    }

    public static func standbyStatus(_ state: ShannonStandbyState, enabled: Bool, lowPowerMode: Bool = false) -> String {
        guard enabled else { return "オフ" }
        if lowPowerMode { return "省電力モード中は待機しません" }
        switch state {
        case .off: return "登録したイヤホンをつなぐと待機します"
        case .standingBy: return "待機中です"
        case .inUse: return "音声を使用中です。終わると待機に戻ります"
        case .stopped: return "待機が止まりました。このアプリを開くと再開します"
        }
    }

    public static func registerTitle(_ name: String) -> String {
        "「\(name)」をイヤホンとして登録"
    }

    public static func removeAccessibilityLabel(_ name: String) -> String {
        "「\(name)」の登録を解除"
    }

    /// What the current output is, and whether only the owner hears it.
    public static func outputDescription(
        _ output: ShannonAudioOutput, registered: [ShannonRegisteredEarphones], wiredCountsAsPrivate: Bool = true
    ) -> String {
        switch output.kind {
        case .wiredHeadphones:
            wiredCountsAsPrivate ? "有線のヘッドホン・自分だけに聞こえます" : "有線の出口・ヘッドホンとして扱いません"
        case .bluetooth, .usb:
            ShannonPrivateListeningJudge.isPrivate(output, registered: registered)
                ? "登録したイヤホン・自分だけに聞こえます"
                : "未登録・イヤホンかスピーカーか区別できません"
        case .builtInSpeaker:
            "内蔵スピーカー・まわりにも聞こえます"
        case .other:
            "イヤホンとして扱えない出口です"
        }
    }

    public static func statusText(_ status: ShannonPrivateListeningStatus) -> String {
        switch status {
        case .notListening: "伝えていません"
        case .othersPresent: "「友人も一緒」のあいだは伝えません"
        case .notPaired: "シャノンに接続すると伝えられます"
        case .waiting: "これから伝えます"
        case .reported: "「自分だけに聞こえる」と伝えています"
        case .unsupported: "サーバーが未対応です。対応したら自動で伝えます"
        case .refused: "サーバー側で止められています"
        case .failed: "伝えられませんでした。次の機会にもう一度伝えます"
        }
    }
}
