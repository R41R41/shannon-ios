import Foundation

/// What the owner is told where a memory stops being used or is brought back.
/// One source for the memory detail, 覚えていること, 記憶の管理 and the capture undo, on iPhone and Mac.
enum ShannonMemoryWithholdingCopy {
    private static let scope = "この内容と、この内容に触れたシャノンの返答や要約を、今後の会話の材料から外します。ほかの返答や要約はそのまま使います。"

    static let forget = scope + "トークの履歴は消えません。「記憶の管理」から復元すると元に戻ります。"
    static let reject = scope + "同じ内容を自動で覚え直すこともありません。「記憶の管理」から復元すると元に戻ります。"
    static let captureUndo = scope + "トークの履歴は消えません。頭の中の「記憶の管理」から復元すると元に戻ります。"
    static let correctionEffect = "訂正前の内容に触れたシャノンの返答は、今後の会話の材料から外します。"
    static let correct = "シャノンが覚える正しい内容を書いてください。" + correctionEffect + "元の根拠と訂正履歴は残ります。"
    static let restore = "復元すると、この内容と、外していたシャノンの返答や要約をまた会話に使います。"
    static let hiddenList = "一覧から詳細を開くと復元できます。復元すると、外していた返答や要約もまた使います。元の会話や根拠を消す操作ではありません。"
}
