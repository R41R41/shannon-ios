import Foundation

public enum ShannonGeminiLivePhase: String, Equatable, Sendable {
    case idle, requestingPermission, connecting, listening, thinking, speaking, reconnecting, failed
    public var isCallActive: Bool { self != .idle && self != .failed }

    public var japaneseLabel: String {
        switch self {
        case .idle: "音声会話を開始"
        case .requestingPermission: "マイクを準備中"
        case .connecting: "接続しています"
        case .listening: "聞いています"
        case .thinking: "考えています"
        case .speaking: "シャノンが話しています"
        case .reconnecting: "会話をつなぎ直しています"
        case .failed: "接続できませんでした"
        }
    }
}
