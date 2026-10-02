import SwiftUI

/// A state shown by shape and words, never by color alone.
struct ShannonOpsStatusGlyph: View {
    let status: ShannonOpsStatus
    /// False for a report that is no longer current: the glyph then claims nothing.
    let isCurrent: Bool
    let palette: ShannonPalette

    var body: some View {
        Image(systemName: symbol)
            .font(.body.weight(.semibold))
            .foregroundStyle(color)
            .frame(width: 24)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        guard isCurrent else { return "questionmark.circle" }
        switch status {
        case .running: return "checkmark.circle.fill"
        case .stopped: return "circle"
        case .degraded: return "exclamationmark.triangle.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    private var color: Color {
        guard isCurrent else { return palette.textSecondary }
        switch status {
        case .running: return palette.success
        case .degraded: return palette.attention
        case .stopped, .unknown: return palette.textSecondary
        }
    }
}

/// One service or schedule: what it is, how it is, and the controls the server accepts for it.
struct ShannonOpsRow: View {
    let title: String
    let detail: String
    let status: ShannonOpsStatus?
    let statusLabel: String?
    let isCurrent: Bool
    let isWaiting: Bool
    let actions: [ShannonOpsAction]
    let palette: ShannonPalette
    let choose: (ShannonOpsAction) -> Void

    var body: some View {
        // Side by side while the name fits on one line; otherwise the controls go below it.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: ShannonSpacing.small) {
                information.fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: ShannonSpacing.small)
                controls
            }
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                information
                if isWaiting || !actions.isEmpty {
                    HStack(spacing: ShannonSpacing.small) { controls }
                }
            }
        }
        .opacity(isCurrent ? 1 : 0.6)
    }

    private var information: some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            if let status {
                ShannonOpsStatusGlyph(status: status, isCurrent: isCurrent, palette: palette)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(palette.textPrimary)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(palette.textSecondary)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([title, subtitle].filter { !$0.isEmpty }.joined(separator: "、"))
    }

    private var subtitle: String {
        [statusLabel, detail.isEmpty ? nil : detail].compactMap { $0 }.joined(separator: "・")
    }

    @ViewBuilder
    private var controls: some View {
        if isWaiting {
            Text("結果待ち…")
                .font(.footnote)
                .foregroundStyle(palette.textSecondary)
        }
        ForEach(actions) { action in
            let label = ShannonOpsText.commandLabel(action.type)
            Button { choose(action) } label: {
                // The label itself is 44 points tall, so the whole capsule is the target.
                Text(label)
                    .lineLimit(1)
                    .frame(minHeight: 44 - 14)
                    .padding(.vertical, 7)
                    .contentShape(Rectangle())
            }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(action.type == .serviceStop || action.type == .minecraftStop ? palette.textSecondary : palette.action)
                .fixedSize()
                .accessibilityLabel("\(action.type == .scheduleRun ? "予定「\(title)」" : title) を\(label)")
                .accessibilityHint("確認の画面を開きます")
        }
    }
}

/// What a Minebot is working on: the task and its steps, each with a mark and a word.
struct ShannonOpsMinebotTaskRow: View {
    let bot: ShannonOpsMinebotDTO
    let current: Bool
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                ShannonOpsStatusGlyph(status: bot.status, isCurrent: current, palette: palette)
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.id).font(.body)
                    Text([current ? ShannonOpsText.statusLabel(bot.status) : ShannonOpsText.staleStatusLabel(bot.status), bot.server]
                        .filter { !$0.isEmpty }.joined(separator: "・"))
                        .font(.footnote)
                        .foregroundStyle(palette.textSecondary)
                }
            }
            .accessibilityElement(children: .combine)

            if let task = bot.task {
                Text(task.title)
                    .font(.callout.weight(.medium))
                    .accessibilityLabel("いまの作業、\(task.title)")
                ForEach(Array(task.steps.enumerated()), id: \.offset) { _, step in
                    HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                        Image(systemName: Self.symbol(step.status))
                            .font(.footnote)
                            .foregroundStyle(step.status == .failed ? palette.danger : palette.textSecondary)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                        Text(step.title)
                            .font(.footnote)
                            .foregroundStyle(step.status == .running ? palette.textPrimary : palette.textSecondary)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(step.title)、\(Self.label(step.status))")
                }
            } else {
                Text("いまの作業はありません")
                    .font(.footnote)
                    .foregroundStyle(palette.textSecondary)
            }
        }
        .opacity(current ? 1 : 0.6)
    }

    static func symbol(_ status: ShannonOpsStepStatus) -> String {
        switch status {
        case .pending: "circle"
        case .running: "play.fill"
        case .done: "checkmark"
        case .failed: "xmark"
        case .skipped: "minus"
        }
    }

    static func label(_ status: ShannonOpsStepStatus) -> String {
        switch status {
        case .pending: "これから"
        case .running: "進行中"
        case .done: "済み"
        case .failed: "失敗"
        case .skipped: "飛ばした"
        }
    }
}

/// One line of the record of operations: when, what, and how it ended.
struct ShannonOpsCommandRow: View {
    let command: ShannonOpsCommandDTO
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Image(systemName: Self.symbol(command.status))
                .font(.footnote)
                .foregroundStyle(Self.tint(command.status, palette: palette))
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(ShannonOpsText.commandSummary(command))
                    .font(.callout)
                    .foregroundStyle(command.status.isOpen ? palette.textPrimary : palette.textSecondary)
                Text(([ShannonYousuTime.clock(command.createdAt), ShannonOpsText.commandStatusLabel(command.status)]
                    + [ShannonOpsText.commandReason(command)].compactMap { $0 }).joined(separator: "・"))
                    .font(.footnote)
                    .foregroundStyle(palette.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    static func symbol(_ status: ShannonOpsCommandStatus) -> String {
        switch status {
        case .pending, .claimed: "hourglass"
        case .done: "checkmark"
        case .failed: "xmark"
        case .refused: "hand.raised"
        case .expired: "clock.badge.xmark"
        case .unknown: "questionmark"
        }
    }

    static func tint(_ status: ShannonOpsCommandStatus, palette: ShannonPalette) -> Color {
        switch status {
        case .pending, .claimed: palette.action
        case .done: palette.textSecondary
        case .failed, .refused, .expired: palette.attention
        case .unknown: palette.textSecondary
        }
    }
}

/// The report did not arrive, or the server did not answer: stated once, above everything.
struct ShannonOpsBanner: View {
    let title: String
    let message: String
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(palette.onAttentionTint)
            Text(message)
                .font(.footnote)
                .foregroundStyle(palette.onAttentionTint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowBackground(palette.attentionTint)
        .accessibilityElement(children: .combine)
    }
}

/// When the report was received, and which release of the runtime sent it.
struct ShannonOpsReportLine: View {
    let received: String
    let release: String
    let started: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(received)
                .font(.callout)
            Text([release.isEmpty ? nil : "版 \(release)", started.map { "起動 \($0)" }].compactMap { $0 }.joined(separator: "・"))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// What became of the last press: recorded and waiting, how it ended, or why it was not sent.
struct ShannonOpsNoticeLine: View {
    let symbol: String
    let tint: Color
    let title: String
    let message: String?
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.small) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.medium))
                if let message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .accessibilityLabel("この知らせを閉じる")
        }
    }
}
