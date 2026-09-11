import SwiftUI

struct ShannonDiaryCard: View {
    let report: ShannonSleepReportDTO
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            HStack {
                Image(systemName: "moon.stars.fill")
                    .foregroundStyle(palette.primary)
                Spacer()
                Text(report.dayKey)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.onSurface)
                .lineLimit(2)
            Text(summary)
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
                .lineLimit(3)
            Spacer(minLength: 0)
            HStack {
                Text("読む")
                Spacer()
                Image(systemName: "chevron.right")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.primary)
        }
        .padding(M3Spacing.large)
        .frame(width: 236, height: 176, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
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
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: symbol)
                .foregroundStyle(palette.primary)
                .frame(width: 36, height: 36)
                .background(palette.secondaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title).font(.body.weight(.semibold))
                if let detail = item.detail, !detail.isEmpty {
                    Text(detail).font(.callout).foregroundStyle(palette.onSurfaceVariant).lineLimit(3)
                }
                Text(displayDate(item.occurredAt)).font(.caption).foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()
        }
        .padding(.vertical, M3Spacing.extraSmall)
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
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: item.kind.symbolName)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.primary)
                .frame(width: 44, height: 44)
                .background(palette.secondaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(item.kind.japaneseName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.primary)
                    if item.pinned { Image(systemName: "pin.fill").foregroundStyle(palette.warning) }
                    if item.status != .active {
                        Text(item.status == .rejected ? "事実ではない" : "忘れる")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(palette.errorContainer, in: Capsule())
                    }
                }
                Text(item.text)
                    .font(.body)
                    .foregroundStyle(item.status == .active ? palette.onSurface : palette.onSurfaceVariant)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                HStack {
                    Text(item.changeReason)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
            }
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.7), lineWidth: 0.7)
        }
    }
}

struct SleepSummaryCard: View {
    let report: ShannonSleepReportDTO
    let palette: M3Palette

    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: "moon.stars.fill")
                .font(.system(size: 25))
                .foregroundStyle(palette.onPrimaryContainer)
                .frame(width: 52, height: 52)
                .background(palette.primaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text("眠っている間に考えたこと")
                    .font(.headline)
                Text(sleepSummary(report))
                    .font(.subheadline)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }
}
