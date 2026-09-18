public enum ShannonDialogueActivity: String, CaseIterable, Equatable, Sendable {
    case idle
    case preparing
    case connecting
    case listening
    case thinking
    case speaking
    case working
    case searching
    case waiting
    case done
    case failed

    public var japaneseLabel: String {
        switch self {
        case .idle: "待機"
        case .preparing: "マイクを準備中"
        case .connecting: "接続中"
        case .listening: "聞いている"
        case .thinking: "考えている"
        case .speaking: "話している"
        case .working: "作業中"
        case .searching: "検索中"
        case .waiting: "待機中"
        case .done: "完了"
        case .failed: "接続失敗"
        }
    }
}
