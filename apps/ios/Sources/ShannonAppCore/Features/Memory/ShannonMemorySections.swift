import SwiftUI

/// Section views shared by the Mac overview and the iPhone category pages.

struct ShannonPersonalityProfileCard: View {
    let profile: ShannonPersonalityProfileDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            HStack {
                Text("性格分析").font(.title3.weight(.semibold))
                Spacer()
                Text("v\(profile.version)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.action)
            }
            Text(profile.analysis)
                .font(.body)
                .lineSpacing(4)
                .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
    }
}

struct ShannonKnowledgeAnswerGroups: View {
    let answers: [ShannonKnowledgeAnswerDTO]
    let palette: ShannonPalette
    let edit: (ShannonKnowledgeAnswerDTO) -> Void

    var body: some View {
        ForEach(ShannonMemoryOverview.knowledgeCategories(answers), id: \.category) { group in
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                Text(group.category).font(.title3.weight(.semibold))
                ForEach(group.answers) { answer in
                    HStack(alignment: .center, spacing: ShannonSpacing.small) {
                        KnowledgeAnswerCard(answer: answer, palette: palette)
                        Button {
                            edit(answer)
                        } label: {
                            Image(systemName: "pencil")
                                .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(palette.action)
                        .accessibilityLabel("\(answer.question)を編集")
                    }
                }
            }
        }
    }
}

struct ShannonWorldItemSection: View {
    let items: [ShannonWorldItemDTO]
    let palette: ShannonPalette
    var title: String? = "見つけたもの"

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            if let title {
                Text(title).font(.title3.weight(.semibold))
            }
            ForEach(items) { item in
                if let url = URL(string: item.url) {
                    Link(destination: url) {
                        WorldItemCard(item: item, palette: palette)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("ブラウザで開きます")
                } else {
                    WorldItemCard(item: item, palette: palette)
                }
            }
        }
    }
}

struct ShannonActivityTimelineSection: View {
    let items: [ShannonActivityItemDTO]
    let palette: ShannonPalette

    var body: some View {
        ForEach(ShannonMemoryOverview.activityGroups(items)) { group in
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                Text(group.title)
                    .font(.title3.weight(.semibold))
                ForEach(group.items) { item in
                    ActivityTimelineRow(item: item, palette: palette)
                }
            }
        }
    }
}

struct ShannonMemoryCardList: View {
    @Bindable var model: ShannonMemoryModel
    let title: String?
    let items: [ShannonMemoryItemDTO]
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            if let title {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .padding(.horizontal, ShannonSpacing.extraSmall)
            }
            ForEach(items) { item in
                NavigationLink {
                    ShannonMemoryDetailView(model: model, memoryID: item.id)
                } label: {
                    MemoryCard(item: item, palette: palette)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct ShannonMemoryEmptyState: View {
    let title: String
    let symbol: String
    var message: String?
    let palette: ShannonPalette

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            if let message {
                Text(message)
            }
        }
        .foregroundStyle(palette.textSecondary)
        .padding(.vertical, ShannonSpacing.huge)
    }
}

/// Native correction sheet for one knowledge answer. The server result is the
/// source of truth; the sheet closes only after a successful save.
struct ShannonKnowledgeCorrectionModifier: ViewModifier {
    @Bindable var model: ShannonMemoryModel
    @Binding var editingAnswer: ShannonKnowledgeAnswerDTO?
    @Binding var editingText: String

    func body(content: Content) -> some View {
        content.sheet(item: $editingAnswer) { answer in
            NavigationStack {
                Form {
                    Section {
                        TextField("回答", text: $editingText, axis: .vertical)
                            .lineLimit(2...8)
                    } header: {
                        Text(answer.question)
                    } footer: {
                        // The pencil records the same owner correction as the memory detail screen.
                        Text("あなたの訂正として記録し、会話や夜の整理で元の内容に戻らないようにします。\(ShannonKnowledgeCorrection.maximumLength)文字まで（いま\(editingText.trimmingCharacters(in: .whitespacesAndNewlines).count)文字）。")
                    }
                    if let error = model.errorMessage {
                        Section {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(Color.shannonDanger)
                        }
                    }
                }
                .navigationTitle("知識を訂正")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("キャンセル") { editingAnswer = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") {
                            let value = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task {
                                if await model.correctKnowledge(answerID: answer.answerId, answer: value) {
                                    editingAnswer = nil
                                }
                            }
                        }
                        .disabled(
                            !ShannonKnowledgeCorrection.isValid(editingText) || model.mutatingMemoryID != nil
                        )
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }
}

/// Shared with the server limit for an owner correction, so the pencil never fails without a reason.
enum ShannonKnowledgeCorrection {
    static let maximumLength = 320

    static func isValid(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !value.isEmpty && value.count <= maximumLength
    }
}
