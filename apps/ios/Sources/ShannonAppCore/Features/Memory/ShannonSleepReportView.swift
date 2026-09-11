import SwiftUI

struct ShannonSleepReportView: View {
    let report: ShannonSleepReportDTO
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.dismiss) var dismiss

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("\(report.dayKey) の睡眠", systemImage: "moon.stars.fill")
                        .font(.title2.weight(.semibold))
                    Text("会話を振り返り、急いで結論にせず整理した結果です。")
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                .padding(M3Spacing.extraLarge)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.primaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                reportSection("新しく覚えたこと", symbol: "plus.circle.fill", changes: report.learned, palette: palette)
                reportSection("理解が深まったこと", symbol: "arrow.triangle.2.circlepath", changes: report.updated, palette: palette)
                reportSection("興味の変化", symbol: "sparkles", changes: report.interestChanges, palette: palette)
                contradictionSection(palette)
            }
            .padding(M3Spacing.large)
        }
        .background(palette.surfaceContainerLow)
        .navigationTitle("睡眠後の変化")
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("閉じる") { dismiss() }
            }
        }
    }

    func reportSection(
        _ title: String, symbol: String, changes: [ShannonSleepChangeDTO], palette: M3Palette
    ) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(title, systemImage: symbol).font(.title3.weight(.semibold))
            if changes.isEmpty {
                Text("今回はありません").foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(changes) { change in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(change.text).font(.body.weight(.medium))
                        Text(change.reason).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }

    func contradictionSection(_ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label("矛盾として保留したこと", systemImage: "arrow.left.arrow.right.circle.fill")
                .font(.title3.weight(.semibold))
            if report.contradictions.isEmpty {
                Text("今回はありません").foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(report.contradictions) { conflict in
                    VStack(alignment: .leading, spacing: M3Spacing.small) {
                        Text("いまの理解").font(.caption.weight(.semibold)).foregroundStyle(palette.primary)
                        Text(conflict.currentText)
                        Divider()
                        Text("新しく見つけた表現").font(.caption.weight(.semibold)).foregroundStyle(palette.onSurface)
                        Text(conflict.candidateText)
                        Text(conflict.reason).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .background(palette.tertiaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }
}

struct MemoryErrorCard: View {
    let message: String
    let palette: M3Palette
    let action: () -> Void
    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(palette.error)
            Text(message).font(.callout)
            Spacer()
            Button("再試行", action: action).font(.callout.weight(.semibold)).foregroundStyle(palette.primary)
        }
        .padding(M3Spacing.large)
        .background(palette.errorContainer, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }
}

func sleepSummary(_ report: ShannonSleepReportDTO) -> String {
    if let interest = report.interestChanges.first { return "「\(interest.text)」が少し心に残った" }
    if let learned = report.learned.first { return "「\(learned.text)」を新しく覚えた" }
    if let updated = report.updated.first { return "「\(updated.text)」への理解が少し深まった" }
    if !report.contradictions.isEmpty { return "まだ決めつけずに置いたことがある" }
    return "昨夜は静かに記憶を整理した"
}

func displayDate(_ value: String) -> String {
    let date = parsedDate(value)
    return date?.formatted(date: .abbreviated, time: .shortened) ?? value
}

func parsedDate(_ value: String) -> Date? {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    return (try? fractional.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
}

func sourceName(_ value: String) -> String {
    switch value {
    case "conversation": "会話"
    case "sleep": "睡眠中の整理"
    case "user": "あなたの訂正"
    default: value
    }
}
