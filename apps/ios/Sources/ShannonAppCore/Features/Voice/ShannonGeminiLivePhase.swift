#if os(iOS)
import Foundation

public enum ShannonGeminiLivePhase: String, Equatable, Sendable {
    case idle, requestingPermission, connecting, listening, thinking, speaking, reconnecting, failed

    public var japaneseLabel: String {
        switch self {
        case .idle: "音声会話を開始"
        case .requestingPermission: "マイクを準備中"
        case .connecting: "Geminiへ接続中"
        case .listening: "聞いています"
        case .thinking: "考えています"
        case .speaking: "シャノンが話しています"
        case .reconnecting: "会話をつなぎ直しています"
        case .failed: "接続できませんでした"
        }
    }
}

func mergedTranscript(_ current: String, _ next: String) -> String {
    let incoming = next.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !incoming.isEmpty else { return current }
    if incoming == current || current.hasSuffix(incoming) { return current }
    if incoming.hasPrefix(current) { return incoming }
    return current.isEmpty ? incoming : current + incoming
}
#endif
