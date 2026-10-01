#if os(iOS)
import SwiftUI

/// The minimized call: a small pill with the call state, elapsed time and an always-present
/// end control. Tapping the pill expands it in place to the details, mute and task actions.
struct ShannonVoiceSessionBar: View {
    @Bindable var model: ShannonGeminiLiveSessionModel
    let task: ShannonAgentTask?
    let showDetails: () -> Void
    let end: () -> Void
    let openTask: (UUID) -> Void
    @State private var isExpanded = false
    @State private var confirmsEnd = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    private var status: ShannonGeminiLiveStatusPresentation {
        ShannonGeminiLiveStatusPresentation(
            phase: model.phase, failureRecovery: model.failureRecovery,
            errorMessage: model.errorMessage, isMuted: model.isMicrophoneMuted, hasConversation: true)
    }

    private var detailSubtitle: String {
        if model.phase == .failed { return "詳細を開いて再接続" }
        if model.participantMode == .guest { return "友人も一緒 · マイク使用中 · 会話は保存しません" }
        return "本人だけ · マイク使用中 · 他のアプリでも通話を継続"
    }

    /// Large text keeps every action visible instead of hiding it behind a small target.
    private var showsDetails: Bool { isExpanded || dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let shape = RoundedRectangle(cornerRadius: showsDetails ? ShannonShape.large : 26, style: .continuous)
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            head(palette)
            if showsDetails { details(palette) }
        }
        .padding(.leading, ShannonSpacing.medium)
        .padding(.trailing, ShannonSpacing.extraSmall)
        .padding(.vertical, showsDetails ? ShannonSpacing.small : 2)
        .foregroundStyle(palette.textPrimary)
        .background {
            if reduceTransparency || contrast == .increased { shape.fill(palette.elevatedSurface) }
            else { shape.fill(.regularMaterial) }
        }
        .overlay { shape.stroke(palette.divider.opacity(0.8), lineWidth: 0.7) }
        .frame(maxWidth: showsDetails ? .infinity : nil)
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.vertical, ShannonSpacing.extraSmall)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(duration: 0.35, bounce: 0), value: isExpanded)
        .confirmationDialog("音声会話を終了しますか？", isPresented: $confirmsEnd, titleVisibility: .visible) {
            Button("終了", role: .destructive, action: end)
            Button("続ける", role: .cancel) {}
        }
    }

    private func head(_ palette: ShannonPalette) -> some View {
        HStack(spacing: ShannonSpacing.small) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack(spacing: ShannonSpacing.small) {
                    indicator(palette)
                    Text(status.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if let callStartedAt = model.callStartedAt {
                        TimelineView(.periodic(from: callStartedAt, by: 1)) { context in
                            let seconds = Int(context.date.timeIntervalSince(callStartedAt))
                            Text(ShannonVoiceCallDuration.text(seconds: seconds))
                                .font(.subheadline.monospacedDigit())
                                .foregroundStyle(palette.textSecondary)
                                .accessibilityLabel(ShannonVoiceCallDuration.accessibilityText(seconds: seconds))
                        }
                    }
                    if model.participantMode == .guest, !showsDetails {
                        Label(ShannonVoiceGuestModeCopy.name, systemImage: "person.2.fill")
                            .font(.caption.weight(.medium))
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(palette.action)
                            .lineLimit(1)
                    }
                    if task != nil, !showsDetails {
                        Image(systemName: "hammer.fill")
                            .font(.caption2)
                            .foregroundStyle(palette.action)
                            .accessibilityLabel("作業あり")
                    }
                    if showsDetails { Spacer(minLength: 0) }
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("音声会話、\(status.title)、\(model.participantMode.japaneseName)")
            .accessibilityValue(isExpanded ? "操作を表示中" : "小さく表示中")
            .accessibilityHint(isExpanded ? "操作をたたみます" : "詳細・ミュート・終了を表示します")

            Button {
                confirmsEnd = true
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(palette.onAction)
                    .frame(width: 32, height: 32)
                    .background(palette.danger, in: Circle())
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声会話を終了する")
            .accessibilityHint("確認してから終了します")
        }
    }

    @ViewBuilder
    private func indicator(_ palette: ShannonPalette) -> some View {
        if model.phase == .failed {
            Image(systemName: "wifi.exclamationmark").foregroundStyle(palette.danger)
        } else if model.isMicrophoneMuted {
            Image(systemName: "mic.slash.fill").font(.caption).foregroundStyle(palette.attention)
        } else {
            ShannonGeminiLiveLevelBar(level: model.audioLevel, phase: model.phase, palette: palette)
        }
    }

    private func details(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Text(detailSubtitle)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
            ShannonButtonRow {
                Button(action: showDetails) { ShannonButtonLabel("詳細を開く") }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("音声会話の詳細を開く")
                Button {
                    model.toggleMicrophoneMute()
                } label: {
                    ShannonButtonLabel(model.isMicrophoneMuted ? "ミュート解除" : "ミュート")
                }
                .buttonStyle(.bordered)
                .disabled(model.phase == .failed)
            }
            if let task {
                Divider()
                Button { openTask(task.id) } label: {
                    HStack(spacing: ShannonSpacing.small) {
                        Image(systemName: task.status.symbolName).foregroundStyle(palette.action)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.title).font(.subheadline.weight(.medium))
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                            Text(task.status == .proposed ? "実装案 · 内容を確認して開始" : "\(task.status.japaneseName) · 作業を見る")
                                .font(.caption).foregroundStyle(palette.textSecondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption)
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(task.title)、\(task.status.japaneseName)、作業を開く")
            }
        }
        .padding(.trailing, ShannonSpacing.small)
        .transition(.opacity)
    }
}
#endif
