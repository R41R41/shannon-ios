import SwiftUI

struct ShannonActivityGroup: Identifiable {
    let id: String
    let title: String
    let items: [ShannonActivityItemDTO]
}

struct ShannonCostCard: View {
    let usage: ShannonLlmUsageSummaryDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            HStack {
                Label("今月のAI使用量", systemImage: "gauge.with.dots.needle.50percent")
                    .font(.shannon(.title3).weight(.semibold))
                Spacer()
                Text(usage.monthKey).font(.shannon(.caption).monospacedDigit()).foregroundStyle(palette.textSecondary)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(usage.estimatedCostUsd, format: .currency(code: "USD"))
                    .font(.shannon(.title2).bold()).foregroundStyle(palette.action)
                Spacer()
                Text("バックグラウンド残り \(usage.backgroundRemainingUsd, format: .currency(code: "USD"))")
                    .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
            }
            if let today = usage.todayBackgroundCostUsd {
                HStack {
                    Text("今日のバックグラウンド")
                    Spacer()
                    Text(today, format: .currency(code: "USD"))
                        .monospacedDigit()
                }
                .font(.shannon(.caption))
                .foregroundStyle(palette.textSecondary)
            }
            ProgressView(
                value: usage.backgroundBudgetUsd > 0
                    ? min(1, usage.backgroundCostUsd / usage.backgroundBudgetUsd)
                    : 1
            )
            .tint(usage.backgroundRemainingUsd > 0 ? palette.action : palette.danger)
            HStack {
                Text("会話 \(calls(for: "chat"))回")
                Spacer()
                Text("音声 \(calls(for: "voice"))回")
                Spacer()
                Text("バックグラウンド \(calls(for: "sleep"))回")
            }
            .font(.shannon(.caption))
            .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.extraLarge)
                .stroke(palette.divider.opacity(0.65), lineWidth: 0.7)
        }
    }

    func calls(for lane: String) -> Int {
        usage.rows.first(where: { $0.lane == lane })?.calls ?? 0
    }
}

struct ShannonInitiativeEvaluationCard: View {
    let evaluation: ShannonInitiativeEvaluationDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            HStack {
                Label("最近の自発性", systemImage: "bubble.left.and.sparkles")
                    .font(.shannon(.title3).weight(.semibold))
                Spacer()
                Text("\(evaluation.windowDays)日")
                    .font(.shannon(.caption).monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(evaluation.deliveryRate, format: .percent.precision(.fractionLength(0)))
                    .font(.shannon(.title2).bold())
                    .foregroundStyle(palette.action)
                Text("話しかけた割合")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                Spacer()
                Text("\(evaluation.delivered)件")
                    .font(.shannon(.body).weight(.semibold))
            }
            ProgressView(value: min(1, evaluation.deliveryRate))
                .tint(palette.action)
            HStack {
                Text("候補 \(evaluation.candidatesConsidered)件")
                Spacer()
                Text("静かにした \(silentRuns)回")
            }
            .font(.shannon(.caption))
            .foregroundStyle(palette.textSecondary)
            if let suppressed = evaluation.repeatedCandidatesSuppressed, suppressed > 0 {
                Label("重複候補を\(suppressed)件、静かに除外", systemImage: "line.3.horizontal.decrease.circle")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }
            if !sourceSummary.isEmpty {
                Text("配信元: \(sourceSummary)")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(2)
            }
        }
        .padding(ShannonSpacing.large)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.extraLarge)
                .stroke(palette.divider.opacity(0.65), lineWidth: 0.7)
        }
    }

    var silentRuns: Int {
        evaluation.stopped.values.reduce(0, +)
    }

    var sourceSummary: String {
        (evaluation.deliveredBySource ?? []).prefix(3)
            .map { "\($0.sourceTitle) \($0.count)件" }
            .joined(separator: "・")
    }
}

struct WorldItemCard: View {
    let item: ShannonWorldItemDTO
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: "globe.asia.australia.fill")
                .foregroundStyle(palette.action)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.shannon(.body).weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                    .lineLimit(3)
                Text(item.sourceTitle)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.shannon(.caption))
                .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.medium)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
    }
}

enum MemoryArea: String, CaseIterable, Identifiable {
    case current, knowledge, activity
    var id: String { rawValue }
    var title: String {
        switch self {
        case .current: "いま"
        case .knowledge: "知識"
        case .activity: "記憶"
        }
    }
    var symbol: String {
        switch self {
        case .current: "waveform.path.ecg"
        case .knowledge: "books.vertical"
        case .activity: "clock.arrow.circlepath"
        }
    }
}
