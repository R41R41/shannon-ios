import SwiftUI

struct ShannonCurrentStateCard: View {
    let state: CompanionStateDTO
    let dailyMind: ShannonDailyMindDTO?
    let palette: ShannonPalette
    @State var showsDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.large) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Label("いまのシャノン", systemImage: "brain.head.profile.fill")
                        .font(.title3.weight(.semibold))
                    Text("更新 \(displayDate(state.updatedAt))")
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                }
                Spacer()
                Text("v\(state.version)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.action)
            }
            HStack(spacing: ShannonSpacing.medium) {
                Image(systemName: dominantState.symbol)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(palette.onUserMessage)
                    .frame(width: 52, height: 52)
                    .background(palette.userMessage, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(dominantState.label)
                        .font(.title2.weight(.semibold))
                    Text(dominantState.value.formatted(.percent.precision(.fractionLength(0))))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                }
            }

            if let focus = dailyMind {
                VStack(alignment: .leading, spacing: 5) {
                    Text("今日の関心")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.action)
                    Text(focus.topic)
                        .font(.title3.weight(.medium))
                        .foregroundStyle(palette.textPrimary)
                    Text(focus.reason)
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                    if let title = focus.sourceTitle, let url = focus.sourceURL, let sourceURL = URL(string: url) {
                        Link(destination: sourceURL) {
                            Label(title, systemImage: "arrow.up.right")
                                .font(.caption.weight(.medium))
                                .lineLimit(1)
                        }
                    }
                }
                .padding(ShannonSpacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.userMessage.opacity(0.56), in: RoundedRectangle(cornerRadius: ShannonShape.large))
            }

            if !state.activeMemories.isEmpty {
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    Text("頭に浮かんでいること")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.textSecondary)
                    ForEach(state.activeMemories.prefix(2)) { memory in
                        HStack(alignment: .top, spacing: ShannonSpacing.small) {
                            Circle().fill(palette.action).frame(width: 6, height: 6).padding(.top, 6)
                            Text(memory.summary)
                                .font(.callout)
                                .foregroundStyle(palette.textPrimary)
                                .lineLimit(2)
                        }
                    }
                }
            }

            DisclosureGroup(isExpanded: $showsDetails) {
                VStack(spacing: ShannonSpacing.medium) {
                    stateMeter("気分", value: (state.emotion.valence + 1) / 2)
                    stateMeter("活性", value: state.emotion.arousal)
                    stateMeter("心の開き", value: state.emotion.openness)
                    stateMeter("好奇心", value: state.temperament.curiosity)
                    stateMeter("親密さ", value: state.temperament.closeness)
                }
                .padding(.top, ShannonSpacing.medium)
            } label: {
                Text("状態の詳細")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.textSecondary)
            }
            .tint(palette.action)
        }
        .padding(ShannonSpacing.large)
        .background(
            LinearGradient(
                colors: [palette.canvas, palette.intelligenceSoft.opacity(0.28)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge)
        )
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.extraLarge)
                .stroke(palette.divider.opacity(0.65), lineWidth: 0.7)
        }
    }

    func stateMeter(_ title: String, value: Double) -> some View {
        VStack(spacing: 5) {
            HStack {
                Text(title).font(.callout)
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
            }
            ProgressView(value: min(1, max(0, value))).tint(palette.action)
        }
    }

    var dominantState: (label: String, symbol: String, value: Double) {
        let mood = ShannonMemoryOverview.mood(for: state)
        return (mood.label, mood.symbol, mood.value)
    }
}

struct MemorySimpleSection: View {
    let title: String
    let symbol: String
    let values: [String]
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label(title, systemImage: symbol).font(.title3.weight(.semibold))
            ForEach(values, id: \.self) { value in
                Text(value)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(ShannonSpacing.medium)
                    .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
            }
        }
    }
}

struct KnowledgeAnswerCard: View {
    let answer: ShannonKnowledgeAnswerDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(answer.question)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.action)
                Spacer()
                if answer.confirmed {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.caption)
                        .foregroundStyle(palette.action)
                }
            }
            Text(answer.answer)
                .font(.body)
                .foregroundStyle(palette.textPrimary)
                .multilineTextAlignment(.leading)
            HStack {
                Text(answer.source == "user" ? "手動編集" : answer.source == "conversation" ? "会話" : "AI推測")
                Spacer()
                Text(answer.confidence.formatted(.percent.precision(.fractionLength(0))))
            }
            .font(.caption)
            .foregroundStyle(palette.textSecondary)
            Text("更新 \(displayDate(answer.updatedAt))")
                .font(.caption2)
                .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.65), lineWidth: 0.7)
        }
    }
}
