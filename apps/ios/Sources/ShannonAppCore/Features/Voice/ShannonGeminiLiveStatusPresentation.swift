import SwiftUI

public enum ShannonGeminiLiveFailureRecovery: Equatable, Sendable {
    case reconnect
    case openSettings
    case updateRequired
}

/// What the compact glyph beside the status line shows.
enum ShannonGeminiLiveInputIndicator: Equatable, Sendable {
    case none
    /// Real microphone level while Shannon is listening.
    case level
    /// The microphone is muted by the user.
    case muted
}

/// The single authoritative status line of the expanded call screen.
///
/// The header and bottom bar carry no phase text, so this presentation is the
/// only place the call state is described on the primary surface.
struct ShannonGeminiLiveStatusPresentation: Equatable, Sendable {
    enum DetailTone: Equatable, Sendable {
        case secondary
        case attention
        case danger
    }

    let title: String
    let detail: String?
    let detailTone: DetailTone
    let inputIndicator: ShannonGeminiLiveInputIndicator

    init(
        phase: ShannonGeminiLivePhase,
        failureRecovery: ShannonGeminiLiveFailureRecovery? = nil,
        errorMessage: String? = nil,
        isMuted: Bool = false,
        hasConversation: Bool = false
    ) {
        let error = errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
        let notice = error?.isEmpty == false ? error : nil
        title = switch phase {
        case .idle: ShannonGeneratedStrings.voiceStart
        case .requestingPermission: "マイクを準備中"
        case .connecting: "接続しています"
        case .listening: isMuted ? "ミュート中" : "聞いています"
        case .thinking: "考えています"
        case .speaking: "シャノンが話しています"
        case .reconnecting: "会話をつなぎ直しています"
        case .failed: "接続できませんでした"
        }
        inputIndicator = switch phase {
        case .listening: isMuted ? .muted : .level
        case .thinking, .speaking: isMuted ? .muted : .none
        case .idle, .requestingPermission, .connecting, .reconnecting, .failed: .none
        }
        if phase == .failed {
            detail = notice ?? Self.recoveryGuidance(failureRecovery)
            detailTone = .danger
        } else if let notice {
            detail = notice
            detailTone = .attention
        } else {
            detailTone = .secondary
            detail = switch phase {
            case .reconnecting: "会話内容を保ったまま、接続を回復しています。"
            case .listening where isMuted: Self.mutedGuidance
            case .listening where !hasConversation: "自然に話しかけてください。途中で遮っても大丈夫です。"
            default: nil
            }
        }
    }

    /// The Mac is clicked, not tapped, and its microphone permission is in System Settings.
    private static var mutedGuidance: String {
#if os(macOS)
        ShannonGeneratedStrings.voiceMacMutedDetail
#else
        "話すときはマイクをタップしてください。"
#endif
    }

    private static func recoveryGuidance(_ recovery: ShannonGeminiLiveFailureRecovery?) -> String {
        switch recovery {
#if os(macOS)
        case .openSettings: ShannonGeneratedStrings.voiceMacMicrophoneDeniedGuidance
#else
        case .openSettings: "設定でマイクを許可してから、もう一度お試しください。"
#endif
        case .updateRequired: "最新版へ更新してから、もう一度開いてください。"
        case .reconnect, .none: "通信を確認して、もう一度つないでください。"
        }
    }

    /// Provider and model identifiers stay out of visible text; VoiceOver users
    /// and the voice diagnostics log can still reach them.
    static func diagnosticsHint(provider: String, model: String, voice: String) -> String {
        "音声: \(provider) · \(model) · \(voice)"
    }
}

/// The mute toggle's visible and spoken state. Icon and label both change, so
/// the state never depends on color alone.
struct ShannonGeminiLiveMicrophoneControl: Equatable, Sendable {
    let title: String
    let systemImage: String
    let accessibilityValue: String
    let accessibilityHint: String

    init(isMuted: Bool) {
        title = isMuted ? "ミュート中" : "マイク"
        systemImage = isMuted ? "mic.slash.fill" : "mic.fill"
        accessibilityValue = isMuted ? "ミュート中" : "オン"
        accessibilityHint = isMuted
            ? "ダブルタップでミュートを解除します。入力マイクの選択は操作から選べます。"
            : "ダブルタップでミュートします。入力マイクの選択は操作から選べます。"
    }
}

/// The latest utterances shown as centered subtitles under the status line.
struct ShannonGeminiLiveSubtitles: Equatable, Sendable {
    let user: String?
    let shannon: String?

    init(speakerName: String, userTranscript: String, shannonTranscript: String) {
        user = Self.lastLine(of: userTranscript).map { "\(speakerName)：\($0)" }
        shannon = Self.lastLine(of: shannonTranscript)
    }

    var isEmpty: Bool { user == nil && shannon == nil }

    private static func lastLine(of text: String) -> String? {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty }
    }
}

enum ShannonVoiceCallDuration {
    static func text(seconds: Int) -> String {
        let value = max(0, seconds)
        let hours = value / 3_600
        let minutes = value % 3_600 / 60
        let remainder = value % 60
        let paddedSeconds = remainder < 10 ? "0\(remainder)" : "\(remainder)"
        guard hours > 0 else { return "\(minutes):\(paddedSeconds)" }
        let paddedMinutes = minutes < 10 ? "0\(minutes)" : "\(minutes)"
        return "\(hours):\(paddedMinutes):\(paddedSeconds)"
    }

    static func accessibilityText(seconds: Int) -> String {
        let value = max(0, seconds)
        let hours = value / 3_600
        let minutes = value % 3_600 / 60
        let remainder = value % 60
        var parts: [String] = []
        if hours > 0 { parts.append("\(hours)時間") }
        if minutes > 0 { parts.append("\(minutes)分") }
        if remainder > 0 || parts.isEmpty { parts.append("\(remainder)秒") }
        return "通話時間 " + parts.joined()
    }
}

#if os(iOS)
struct ShannonGeminiLiveStatusView: View {
    let presentation: ShannonGeminiLiveStatusPresentation
    let level: Float
    let phase: ShannonGeminiLivePhase
    let palette: ShannonPalette

    var body: some View {
        VStack(spacing: ShannonSpacing.extraSmall) {
            HStack(alignment: .center, spacing: ShannonSpacing.small) {
                switch presentation.inputIndicator {
                case .level:
                    ShannonGeminiLiveLevelBar(level: level, phase: phase, palette: palette)
                case .muted:
                    Image(systemName: "mic.slash.fill")
                        .font(.shannon(.body).weight(.semibold))
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityHidden(true)
                case .none:
                    EmptyView()
                }
                Text(presentation.title)
                    .font(.shannon(.title3).weight(.semibold))
                    .multilineTextAlignment(.center)
            }
            if let detail = presentation.detail {
                Text(detail)
                    .font(.shannon(.footnote))
                    .foregroundStyle(detailColor)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 560)
        .accessibilityElement(children: .combine)
    }

    private var detailColor: Color {
        switch presentation.detailTone {
        case .secondary: palette.textSecondary
        case .attention: palette.onAttentionTint
        case .danger: palette.onDangerTint
        }
    }
}
#endif
