import SwiftUI

struct ShannonCurrentStateCard: View {
    let state: CompanionStateDTO
    let dailyMind: ShannonDailyMindDTO?
    let palette: M3Palette
    @State var showsDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.large) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Label("いまのシャノン", systemImage: "brain.head.profile.fill")
                        .font(.title3.weight(.semibold))
                    Text("更新 \(displayDate(state.updatedAt))")
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                Spacer()
                Text("v\(state.version)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.primary)
            }
            HStack(spacing: M3Spacing.medium) {
                Image(systemName: dominantState.symbol)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(palette.onPrimaryContainer)
                    .frame(width: 52, height: 52)
                    .background(palette.primaryContainer, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(dominantState.label)
                        .font(.title2.weight(.semibold))
                    Text(dominantState.value.formatted(.percent.precision(.fractionLength(0))))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.onSurfaceVariant)
                }
            }

            if let focus = dailyMind {
                VStack(alignment: .leading, spacing: 5) {
                    Text("今日の関心")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.primary)
                    Text(focus.topic)
                        .font(.title3.weight(.medium))
                        .foregroundStyle(palette.onSurface)
                    Text(focus.reason)
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                    if let title = focus.sourceTitle, let url = focus.sourceURL, let sourceURL = URL(string: url) {
                        Link(destination: sourceURL) {
                            Label(title, systemImage: "arrow.up.right")
                                .font(.caption.weight(.medium))
                                .lineLimit(1)
                        }
                    }
                }
                .padding(M3Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.primaryContainer.opacity(0.56), in: RoundedRectangle(cornerRadius: M3Shape.large))
            }

            if !state.activeMemories.isEmpty {
                VStack(alignment: .leading, spacing: M3Spacing.small) {
                    Text("頭に浮かんでいること")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.onSurfaceVariant)
                    ForEach(state.activeMemories.prefix(2)) { memory in
                        HStack(alignment: .top, spacing: M3Spacing.small) {
                            Circle().fill(palette.primary).frame(width: 6, height: 6).padding(.top, 6)
                            Text(memory.summary)
                                .font(.callout)
                                .foregroundStyle(palette.onSurface)
                                .lineLimit(2)
                        }
                    }
                }
            }

            DisclosureGroup(isExpanded: $showsDetails) {
                VStack(spacing: M3Spacing.medium) {
                    stateMeter("気分", value: (state.emotion.valence + 1) / 2)
                    stateMeter("活性", value: state.emotion.arousal)
                    stateMeter("心の開き", value: state.emotion.openness)
                    stateMeter("好奇心", value: state.temperament.curiosity)
                    stateMeter("親密さ", value: state.temperament.closeness)
                }
                .padding(.top, M3Spacing.medium)
            } label: {
                Text("状態の詳細")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            .tint(palette.primary)
        }
        .padding(M3Spacing.large)
        .background(
            LinearGradient(
                colors: [palette.surface, palette.intelligenceSoft.opacity(0.28)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: M3Shape.extraLarge)
        )
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.extraLarge)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
    }

    func stateMeter(_ title: String, value: Double) -> some View {
        VStack(spacing: 5) {
            HStack {
                Text(title).font(.callout)
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            ProgressView(value: min(1, max(0, value))).tint(palette.primary)
        }
    }

    var dominantState: (label: String, symbol: String, value: Double) {
        let candidates = [
            ("好奇心が強い", "sparkles", state.temperament.curiosity),
            ("心を開いている", "heart.circle.fill", state.emotion.openness),
            ("元気がある", "bolt.fill", state.emotion.arousal),
            ("穏やか", "cloud.sun.fill", state.temperament.calmness),
            ("距離が近い", "person.2.fill", state.temperament.closeness),
        ]
        return candidates.max(by: { $0.2 < $1.2 }) ?? candidates[0]
    }
}

struct MemorySimpleSection: View {
    let title: String
    let symbol: String
    let values: [String]
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(title, systemImage: symbol).font(.title3.weight(.semibold))
            ForEach(values, id: \.self) { value in
                Text(value)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(M3Spacing.medium)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.medium))
            }
        }
    }
}

struct KnowledgeAnswerCard: View {
    let answer: ShannonKnowledgeAnswerDTO
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(answer.question)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.primary)
                Spacer()
                if answer.confirmed {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.caption)
                        .foregroundStyle(palette.primary)
                }
            }
            Text(answer.answer)
                .font(.body)
                .foregroundStyle(palette.onSurface)
                .multilineTextAlignment(.leading)
            HStack {
                Text(answer.source == "user" ? "手動編集" : answer.source == "conversation" ? "会話" : "AI推測")
                Spacer()
                Text(answer.confidence.formatted(.percent.precision(.fractionLength(0))))
            }
            .font(.caption)
            .foregroundStyle(palette.onSurfaceVariant)
            Text("更新 \(displayDate(answer.updatedAt))")
                .font(.caption2)
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
    }
}
