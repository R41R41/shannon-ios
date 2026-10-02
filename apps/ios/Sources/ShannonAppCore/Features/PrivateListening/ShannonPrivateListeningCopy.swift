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
        + "登録はこの端末にだけ保存し、機器の名前はサーバーへ送りません。"

    public static func registerTitle(_ name: String) -> String {
        "「\(name)」をイヤホンとして登録"
    }

    public static func removeAccessibilityLabel(_ name: String) -> String {
        "「\(name)」の登録を解除"
    }

    /// What the current output is, and whether only the owner hears it.
    public static func outputDescription(_ output: ShannonAudioOutput, registered: [ShannonRegisteredEarphones]) -> String {
        switch output.kind {
        case .wiredHeadphones:
            "有線のヘッドホン・自分だけに聞こえます"
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
