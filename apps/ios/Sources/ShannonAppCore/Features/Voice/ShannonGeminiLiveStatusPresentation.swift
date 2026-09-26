import SwiftUI

public enum ShannonGeminiLiveFailureRecovery: Equatable, Sendable {
    case reconnect
    case openSettings
    case updateRequired
}

struct ShannonGeminiLiveStatusPresentation: Equatable, Sendable {
    let title: String
    let subtitle: String

    init(
        phase: ShannonGeminiLivePhase,
        failureRecovery: ShannonGeminiLiveFailureRecovery? = nil
    ) {
        title = switch phase {
        case .idle: "音声会話を開始"
        case .requestingPermission: "マイクを準備中"
        case .connecting: "Geminiへ接続中"
        case .listening: "聞いています"
        case .thinking: "考えています"
        case .speaking: "シャノンが話しています"
        case .reconnecting: "会話をつなぎ直しています"
        case .failed: "接続できませんでした"
        }
        subtitle = switch phase {
        case .idle:
            "音声会話を始める準備ができています。"
        case .requestingPermission:
            "マイクの利用許可を確認しています。"
        case .connecting:
            "安全な音声接続を準備しています。"
        case .listening:
            "自然に話しかけてください。途中で遮っても大丈夫です。"
        case .thinking:
            "返答を準備しています。そのままお待ちください。"
        case .speaking:
            "途中で話しかけると、返答を止めて聞き直します。"
        case .reconnecting:
            "会話内容を保ったまま、接続を回復しています。"
        case .failed:
            switch failureRecovery {
            case .openSettings:
                "設定でマイクを許可してから、もう一度お試しください。"
            case .updateRequired:
                "最新版へ更新してから、もう一度開いてください。"
            case .reconnect, .none:
                "通信を確認して、もう一度つないでください。"
            }
        }
    }
}

#if os(iOS)
struct ShannonGeminiLiveStatusView: View {
    let phase: ShannonGeminiLivePhase
    let failureRecovery: ShannonGeminiLiveFailureRecovery?
    let palette: ShannonPalette

    var body: some View {
        let presentation = ShannonGeminiLiveStatusPresentation(
            phase: phase,
            failureRecovery: failureRecovery
        )
        VStack(spacing: 4) {
            Text(presentation.title).font(.title3.weight(.semibold))
            Text(presentation.subtitle)
                .font(.footnote)
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
        }
    }
}
#endif
