import SwiftUI

struct ShannonSleepReportView: View {
    let report: ShannonSleepReportDTO
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.dismiss) var dismiss

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraLarge) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("\(report.dayKey) の睡眠", systemImage: "moon.stars.fill")
                        .font(.shannon(.title2).weight(.semibold))
                    Text("会話を振り返り、急いで結論にせず整理した結果です。")
                        .foregroundStyle(palette.textSecondary)
                }
                .padding(ShannonSpacing.extraLarge)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.userMessage, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
                reportSection("新しく覚えたこと", symbol: "plus.circle.fill", changes: report.learned, palette: palette)
                reportSection("理解が深まったこと", symbol: "arrow.triangle.2.circlepath", changes: report.updated, palette: palette)
                reportSection("興味の変化", symbol: "sparkles", changes: report.interestChanges, palette: palette)
                contradictionSection(palette)
                if let review = report.commitmentReview {
                    VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                        Label("約束の点検", systemImage: "calendar.badge.checkmark").font(.shannon(.title3).weight(.semibold))
                        Text("未完了 \(review.pending)件・完了 \(review.completed)件・取り消し \(review.dismissed)件")
                        Text("期限の確認が必要 \(review.needsDateClarification)件・時刻を過ぎた約束 \(review.overdue)件")
                            .foregroundStyle(palette.textSecondary)
                        Text("睡眠中に勝手に完了にはしません。変更は記憶の詳細から確認できます。")
                            .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    }
                    .padding(ShannonSpacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
                }
            }
            .padding(ShannonSpacing.large)
        }
        .background(palette.readingSurface)
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
        _ title: String, symbol: String, changes: [ShannonSleepChangeDTO], palette: ShannonPalette
    ) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label(title, systemImage: symbol).font(.shannon(.title3).weight(.semibold))
            if changes.isEmpty {
                Text("今回はありません").foregroundStyle(palette.textSecondary)
            } else {
                ForEach(changes) { change in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(change.text).font(.shannon(.body).weight(.medium))
                        Text(change.reason).font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    }
                    .padding(ShannonSpacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
                }
            }
        }
    }

    func contradictionSection(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label("矛盾として保留したこと", systemImage: "arrow.left.arrow.right.circle.fill")
                .font(.shannon(.title3).weight(.semibold))
            if report.contradictions.isEmpty {
                Text("今回はありません").foregroundStyle(palette.textSecondary)
            } else {
                ForEach(report.contradictions) { conflict in
                    VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                        Text("いまの理解").font(.shannon(.caption).weight(.semibold)).foregroundStyle(palette.action)
                        Text(conflict.currentText)
                        Divider()
                        Text("新しく見つけた表現").font(.shannon(.caption).weight(.semibold)).foregroundStyle(palette.textPrimary)
                        Text(conflict.candidateText)
                        Text(conflict.reason).font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    }
                    .padding(ShannonSpacing.large)
                    .background(palette.creationTint, in: RoundedRectangle(cornerRadius: ShannonShape.large))
                }
            }
        }
    }
}

struct MemoryErrorCard: View {
    let message: String
    let palette: ShannonPalette
    let action: () -> Void
    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(palette.danger)
            Text(message).font(.shannon(.callout))
            Spacer()
            Button("再試行", action: action).font(.shannon(.callout).weight(.semibold)).foregroundStyle(palette.action)
        }
        .padding(ShannonSpacing.large)
        .background(palette.dangerTint, in: RoundedRectangle(cornerRadius: ShannonShape.large))
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
