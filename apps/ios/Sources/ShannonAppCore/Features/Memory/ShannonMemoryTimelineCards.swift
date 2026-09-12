import SwiftUI

struct ShannonDiaryCard: View {
    let report: ShannonSleepReportDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            HStack {
                Image(systemName: "moon.stars.fill")
                    .foregroundStyle(palette.action)
                Spacer()
                Text(report.dayKey)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
            }
            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.textPrimary)
                .lineLimit(2)
            Text(summary)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .lineLimit(3)
            Spacer(minLength: 0)
            HStack {
                Text("読む")
                Spacer()
                Image(systemName: "chevron.right")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.action)
        }
        .padding(ShannonSpacing.large)
        .frame(width: 236, height: 176, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.65), lineWidth: 0.7)
        }
    }

    var title: String {
        if let interest = report.interestChanges.first { return interest.text }
        if let learned = report.learned.first { return learned.text }
        if let updated = report.updated.first { return updated.text }
        if !report.contradictions.isEmpty { return "まだ決めずに置いておくこと" }
        return "静かに整理した夜"
    }

    var summary: String {
        if let interest = report.interestChanges.first {
            return "「\(interest.text)」が、今日は少し心に残った。"
        }
        if let learned = report.learned.first {
            return "あなたについて「\(learned.text)」を新しく覚えた。"
        }
        if let updated = report.updated.first {
            return "「\(updated.text)」について、前より少し理解が深まった。"
        }
        if !report.contradictions.isEmpty {
            return "まだ決めつけずに置いておきたいことがあった。"
        }
        return "今日は大きく書き換えず、静かに覚えている。"
    }
}

struct ActivityTimelineRow: View {
    let item: ShannonActivityItemDTO
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: symbol)
                .foregroundStyle(palette.action)
                .frame(width: 36, height: 36)
                .background(palette.subtleSurface, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title).font(.body.weight(.semibold))
                if let detail = item.detail, !detail.isEmpty {
                    Text(detail).font(.callout).foregroundStyle(palette.textSecondary).lineLimit(3)
                }
                Text(displayDate(item.occurredAt)).font(.caption).foregroundStyle(palette.textSecondary)
            }
            Spacer()
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
    }

    var symbol: String {
        switch item.type {
        case "sleep": "moon.stars.fill"
        case "knowledge": "brain.head.profile"
        case "conversation": "bubble.left.and.bubble.right"
        default: "sparkles"
        }
    }
}

struct MemoryCard: View {
    let item: ShannonMemoryItemDTO
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: item.kind.symbolName)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.action)
                .frame(width: 44, height: 44)
                .background(palette.subtleSurface, in: Circle())
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(item.kind.japaneseName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.action)
                    if item.pinned { Image(systemName: "pin.fill").foregroundStyle(palette.attention) }
                    if item.status != .active {
                        Text(item.status == .rejected ? "事実ではない" : "忘れる")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(palette.dangerTint, in: Capsule())
                    }
                }
                Text(item.text)
                    .font(.body)
                    .foregroundStyle(item.status == .active ? palette.textPrimary : palette.textSecondary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                HStack {
                    Text(item.changeReason)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
            }
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
    }
}

struct SleepSummaryCard: View {
    let report: ShannonSleepReportDTO
    let palette: ShannonPalette

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: "moon.stars.fill")
                .font(.system(size: 25))
                .foregroundStyle(palette.onUserMessage)
                .frame(width: 52, height: 52)
                .background(palette.userMessage, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text("眠っている間に考えたこと")
                    .font(.headline)
                Text(sleepSummary(report))
                    .font(.subheadline)
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
    }
}
