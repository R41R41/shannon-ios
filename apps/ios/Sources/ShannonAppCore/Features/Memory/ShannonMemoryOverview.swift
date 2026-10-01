import Foundation

/// Pure projection behind the iPhone 頭の中 overview: the いま card and the
/// category rows. It never hides the durable management path; counts are
/// derived from the same dashboard/cognition values the detail pages show.
struct ShannonMemoryOverview: Equatable {
    enum Category: String, CaseIterable, Identifiable {
        case commitments, knowledge, relationship, diary, discoveries

        var id: String { rawValue }

        var title: String {
            switch self {
            case .commitments: "約束と目的"
            case .knowledge: "覚えていること"
            case .relationship: "ふたりの関係"
            case .diary: "日記"
            case .discoveries: "見つけたもの"
            }
        }

        var symbol: String {
            switch self {
            case .commitments: "target"
            case .knowledge: "books.vertical"
            case .relationship: "heart.text.square"
            case .diary: "book.closed"
            case .discoveries: "globe.asia.australia"
            }
        }

        var emptyTitle: String {
            switch self {
            case .commitments: "約束と目的はまだありません"
            case .knowledge: "覚えていることはまだありません"
            case .relationship: "ふたりの関係はまだ記録されていません"
            case .diary: "日記はまだありません"
            case .discoveries: "見つけたものはまだありません"
            }
        }

        var emptyMessage: String {
            switch self {
            case .commitments: "会話で約束したことや「目標は〜」と伝えた目的が、ここに残ります。"
            case .knowledge: "会話で知ったあなたのこと、シャノンの性格分析や興味がここにまとまります。"
            case .relationship: "会話を重ねると、ふたりの関係について覚えたことがここに残ります。"
            case .diary: "シャノンが眠っている間に記憶を整理すると、その夜の日記が残ります。"
            case .discoveries: "情報源からシャノンが見つけた記事やページがここに並びます。"
            }
        }
    }

    enum Value: Equatable {
        case loading
        case unavailable
        case count(Int)
        case text(String)

        /// Short trailing text for a category row; `nil` means a progress view.
        var label: String? {
            switch self {
            case .loading: nil
            case .unavailable: "—"
            case .count(let value): "\(value)"
            case .text(let value): value
            }
        }

        var accessibilityValue: String {
            switch self {
            case .loading: "読み込み中"
            case .unavailable: "読み込めませんでした"
            case .count(let value): "\(value)件"
            case .text(let value): value
            }
        }
    }

    /// 「いま」: Shannon's current feeling as the server presents it, never the largest trait.
    struct Mood: Equatable {
        let label: String
        let expression: ShannonExpressionDTO
        /// Why she feels this way; nil once the last conversational feeling has settled.
        let cause: String?
    }

    static let featuredIntentLimit = 3

    let dashboard: ShannonMemoryDashboardDTO?
    let cognition: ShannonCognitionDashboardDTO
    let isLoading: Bool
    let hasMemoryError: Bool
    let hasCognitionError: Bool

    init(
        dashboard: ShannonMemoryDashboardDTO?,
        cognition: ShannonCognitionDashboardDTO,
        isLoading: Bool = false,
        hasMemoryError: Bool = false,
        hasCognitionError: Bool = false
    ) {
        self.dashboard = dashboard
        self.cognition = cognition
        self.isLoading = isLoading
        self.hasMemoryError = hasMemoryError
        self.hasCognitionError = hasCognitionError
    }

    @MainActor
    init(model: ShannonMemoryModel) {
        self.init(
            dashboard: model.dashboard,
            cognition: model.cognition,
            isLoading: model.isLoading,
            hasMemoryError: model.errorMessage != nil,
            hasCognitionError: model.cognitionErrorMessage != nil
        )
    }

    // MARK: いま

    var mood: Mood? {
        dashboard?.currentState.map(Self.mood(for:))
    }

    /// One line of what Shannon is thinking about now: today's focus first,
    /// then the most relevant active memory.
    var thinkingLine: String? {
        if let topic = dashboard?.dailyMind?.topic.trimmed, !topic.isEmpty { return topic }
        if let memory = dashboard?.currentState?.activeMemories.first?.summary.trimmed, !memory.isEmpty {
            return memory
        }
        return nil
    }

    var featuredIntents: [ShannonCognitiveIntentDTO] {
        Array(
            cognition.intents
                .filter { $0.status == .active }
                .sorted { lhs, rhs in
                    lhs.priority == rhs.priority ? lhs.updatedAt > rhs.updatedAt : lhs.priority > rhs.priority
                }
                .prefix(Self.featuredIntentLimit)
        )
    }

    var activeIntentCount: Int { cognition.intents.filter { $0.status == .active }.count }

    var hiddenActiveIntentCount: Int { max(0, activeIntentCount - featuredIntents.count) }

    static func mood(for state: CompanionStateDTO) -> Mood {
        guard let presented = state.presence?.mood else {
            // A server that predates the presented state sends no feeling; show a quiet face
            // rather than naming a constant trait as her mood.
            let quiet = ShannonFace(expression: .calm)
            return Mood(label: quiet.japaneseName, expression: quiet.expression, cause: nil)
        }
        return Mood(
            label: presented.face.japaneseName,
            expression: presented.face.expression,
            cause: presented.fromConversation && !presented.cause.isEmpty ? presented.cause : nil
        )
    }

    // MARK: Categories

    private var library: ShannonMemoryLibrary { ShannonMemoryLibrary(dashboard: dashboard) }

    func value(for category: Category) -> Value {
        if category == .commitments {
            guard dashboard != nil || cognition != .empty else { return missingValue(hasError: hasMemoryError || hasCognitionError) }
            let pending = library.items(in: .pending).count
            let intents = cognition.intents.filter { $0.status == .active || $0.status == .paused }.count
            return .count(pending + intents)
        }
        guard dashboard != nil else { return missingValue(hasError: hasMemoryError) }
        return .count(count(for: category))
    }

    func count(for category: Category) -> Int {
        switch category {
        case .commitments:
            library.items(in: .pending).count
                + cognition.intents.filter { $0.status == .active || $0.status == .paused }.count
        case .knowledge:
            knowledgeAnswers.isEmpty ? userFacts.count : knowledgeAnswers.count
        case .relationship:
            relationships.count
        case .diary:
            dashboard?.sleepReports.count ?? 0
        case .discoveries:
            dashboard?.world?.count ?? 0
        }
    }

    func isEmpty(_ category: Category) -> Bool {
        switch category {
        case .knowledge:
            count(for: .knowledge) == 0 && interests.isEmpty && dashboard?.personalityProfile == nil
        default:
            count(for: category) == 0
        }
    }

    var usageAndActivityValue: Value {
        guard let dashboard else { return missingValue(hasError: hasMemoryError) }
        if let usage = dashboard.usage {
            return .text(usage.estimatedCostUsd.formatted(.currency(code: "USD")))
        }
        return .count(activityItems.count)
    }

    var managementSummary: String {
        dashboard == nil ? "読み込み・再試行はこちらから" : library.summary
    }

    // MARK: Page content

    var knowledgeAnswers: [ShannonKnowledgeAnswerDTO] { dashboard?.knowledge ?? [] }

    var userFacts: [ShannonMemoryItemDTO] { activeItems(of: .userFact) }

    var relationships: [ShannonMemoryItemDTO] { activeItems(of: .relationship) }

    var experiences: [ShannonMemoryItemDTO] { activeItems(of: .experience) }

    /// Interests from the current state when present, otherwise saved interest memories.
    var interests: [String] {
        if let interests = dashboard?.currentState?.interests, !interests.isEmpty { return interests }
        return activeItems(of: .interest).map(\.text)
    }

    var activityItems: [ShannonActivityItemDTO] { dashboard?.activity ?? [] }

    private func activeItems(of kind: ShannonMemoryKindDTO) -> [ShannonMemoryItemDTO] {
        (dashboard?.items ?? []).filter { $0.status == .active && $0.kind == kind && $0.commitment == nil }
    }

    private func missingValue(hasError: Bool) -> Value {
        hasError && !isLoading ? .unavailable : .loading
    }

    // MARK: Shared grouping

    static func knowledgeCategories(
        _ answers: [ShannonKnowledgeAnswerDTO]
    ) -> [(category: String, answers: [ShannonKnowledgeAnswerDTO])] {
        let grouped = Dictionary(grouping: answers, by: \.category)
        let order = ["基本情報", "趣味嗜好", "興味", "その他"]
        return grouped.map { ($0.key, $0.value) }.sorted {
            let lhs = order.firstIndex(of: $0.0) ?? 99
            let rhs = order.firstIndex(of: $1.0) ?? 99
            return lhs == rhs ? $0.0 < $1.0 : lhs < rhs
        }
    }

    static func activityGroups(
        _ items: [ShannonActivityItemDTO],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [ShannonActivityGroup] {
        let thisWeek = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        var today: [ShannonActivityItemDTO] = []
        var week: [ShannonActivityItemDTO] = []
        var earlier: [ShannonActivityItemDTO] = []

        for item in items {
            guard let date = parsedDate(item.occurredAt) else {
                earlier.append(item)
                continue
            }
            if calendar.isDate(date, inSameDayAs: now) {
                today.append(item)
            } else if date >= thisWeek {
                week.append(item)
            } else {
                earlier.append(item)
            }
        }

        return [
            ShannonActivityGroup(id: "today", title: "今日", items: today),
            ShannonActivityGroup(id: "week", title: "今週", items: week),
            ShannonActivityGroup(id: "earlier", title: "それ以前", items: earlier),
        ].filter { !$0.items.isEmpty }
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
