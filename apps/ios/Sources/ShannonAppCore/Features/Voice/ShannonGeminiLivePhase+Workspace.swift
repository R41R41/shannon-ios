extension ShannonGeminiLivePhase {
    var workspaceTitle: String {
        switch self {
        case .idle: "音声会話を終了しました"
        case .requestingPermission: "マイクの許可を確認中"
        case .connecting: "音声会話へ接続中"
        case .listening: "シャノンが聞いています"
        case .thinking: "シャノンが考えています"
        case .speaking: "シャノンが話しています"
        case .reconnecting: "音声会話へ再接続中"
        case .failed: "音声会話の接続を確認"
        }
    }
}
