import Foundation
import SwiftUI
import Testing
@testable import ShannonAppCore
#if os(macOS)
import AppKit
#endif

struct ShannonMemoryOverviewTests {
    @Test
    func categoriesFollowTheApprovedOrderAndExplainEmptyPages() {
        #expect(ShannonMemoryOverview.Category.allCases.map(\.title)
            == ["約束と目的", "覚えていること", "ふたりの関係", "日記", "見つけたもの"])
        for category in ShannonMemoryOverview.Category.allCases {
            #expect(!category.emptyTitle.isEmpty)
            #expect(!category.emptyMessage.isEmpty)
            #expect(!category.symbol.isEmpty)
        }
    }

    @Test
    func rowsStayVisibleWhileLoadingAndShowUnavailableAfterFailure() {
        let loading = ShannonMemoryOverview(dashboard: nil, cognition: .empty, isLoading: true)
        let notYetLoaded = ShannonMemoryOverview(dashboard: nil, cognition: .empty)
        let failed = ShannonMemoryOverview(
            dashboard: nil, cognition: .empty, hasMemoryError: true, hasCognitionError: true
        )
        for category in ShannonMemoryOverview.Category.allCases {
            #expect(loading.value(for: category) == .loading)
            #expect(notYetLoaded.value(for: category) == .loading)
            #expect(failed.value(for: category) == .unavailable)
        }
        #expect(loading.usageAndActivityValue == .loading)
        #expect(failed.usageAndActivityValue == .unavailable)
        #expect(ShannonMemoryOverview.Value.loading.label == nil)
        #expect(ShannonMemoryOverview.Value.unavailable.accessibilityValue == "読み込めませんでした")
        #expect(ShannonMemoryOverview.Value.count(3).label == "3")
        #expect(ShannonMemoryOverview.Value.count(3).accessibilityValue == "3件")
        #expect(!failed.managementSummary.isEmpty)
    }

    @Test
    func countsMatchWhatEachPageShows() throws {
        let overview = ShannonMemoryOverview(
            dashboard: try OverviewFixture.dashboard(),
            cognition: OverviewFixture.cognition()
        )
        // 1 pending commitment + 3 active + 1 paused intent; completed/dismissed are not counted.
        #expect(overview.value(for: .commitments) == .count(5))
        #expect(overview.value(for: .knowledge) == .count(2))
        #expect(overview.value(for: .relationship) == .count(1))
        #expect(overview.value(for: .diary) == .count(1))
        #expect(overview.value(for: .discoveries) == .count(2))
        #expect(overview.usageAndActivityValue == .text(1.5.formatted(.currency(code: "USD"))))
        #expect(overview.managementSummary == ShannonMemoryLibrary(dashboard: overview.dashboard).summary)
    }

    @Test
    func commitmentsCountWithOnlyCognitionLoaded() {
        let overview = ShannonMemoryOverview(
            dashboard: nil, cognition: OverviewFixture.cognition(), hasMemoryError: true
        )
        #expect(overview.value(for: .commitments) == .count(4))
        #expect(overview.value(for: .knowledge) == .unavailable)
    }

    @Test
    func knowledgeFallsBackToSavedFactsAndConsidersInterestsAndProfile() throws {
        let factsOnly = ShannonMemoryOverview(
            dashboard: try OverviewFixture.dashboard(knowledge: false, profile: false, interests: []),
            cognition: .empty
        )
        #expect(factsOnly.knowledgeAnswers.isEmpty)
        #expect(factsOnly.value(for: .knowledge) == .count(1))
        #expect(factsOnly.userFacts.map(\.id) == ["fact"])
        // Saved interest memories stand in for missing state interests.
        #expect(factsOnly.interests == ["合成の興味メモ"])
        #expect(!factsOnly.isEmpty(.knowledge))

        let empty = ShannonMemoryOverview(
            dashboard: ShannonMemoryDashboardDTO(generatedAt: "2026-09-30T00:00:00Z", items: [], sleepReports: []),
            cognition: .empty
        )
        for category in ShannonMemoryOverview.Category.allCases {
            #expect(empty.isEmpty(category))
            #expect(empty.value(for: category) == .count(0))
        }
        #expect(empty.usageAndActivityValue == .count(0))
        #expect(empty.mood == nil)
        #expect(empty.thinkingLine == nil)
    }

    @Test
    func featuredIntentsAreActiveOnlyByPriorityAndCapped() {
        let overview = ShannonMemoryOverview(dashboard: nil, cognition: OverviewFixture.cognition(activeCount: 4))
        #expect(overview.featuredIntents.map(\.id) == ["active-4", "active-3", "active-2"])
        #expect(overview.featuredIntents.allSatisfy { $0.status == .active })
        #expect(overview.activeIntentCount == 4)
        #expect(overview.hiddenActiveIntentCount == 1)

        let none = ShannonMemoryOverview(dashboard: nil, cognition: .empty)
        #expect(none.featuredIntents.isEmpty)
        #expect(none.hiddenActiveIntentCount == 0)
    }

    @Test
    func thinkingLinePrefersTodaysFocusThenActiveMemory() throws {
        let withFocus = ShannonMemoryOverview(dashboard: try OverviewFixture.dashboard(), cognition: .empty)
        #expect(withFocus.thinkingLine == "雨の日の散歩")
        let withoutFocus = ShannonMemoryOverview(
            dashboard: try OverviewFixture.dashboard(dailyMind: false),
            cognition: .empty
        )
        #expect(withoutFocus.thinkingLine == "旅行の写真の話")
    }

    @Test
    func moodIsThePresentedFeelingAndNeverTheLargestTrait() throws {
        // The strongest constant trait used to be named as her mood (「好奇心が強い」).
        let curious = try OverviewFixture.state(curiosity: 0.9, openness: 0.4, arousal: 0.3, calmness: 0.2, closeness: 0.1)
        #expect(ShannonMemoryOverview.mood(for: curious).label == "穏やか")
        #expect(ShannonMemoryOverview.mood(for: curious).expression == .calm)
        #expect(ShannonMemoryOverview.mood(for: curious).cause == nil)

        var object = OverviewFixture.stateObject()
        object["presence"] = [
            "mood": ["expression": "determined", "feeling": "proud", "cause": "生成した応答の内容と会話文脈", "fromConversation": true],
            "temperamentReasons": ["closeness": "この30日で12日話した", "curiosity": "いま育っている関心1件",
                                   "confidenceAboutUser": "覚えていること3件から"],
        ]
        let proud = try OverviewFixture.decode(CompanionStateDTO.self, object)
        #expect(ShannonMemoryOverview.mood(for: proud).label == "得意げ")
        #expect(ShannonMemoryOverview.mood(for: proud).expression == .determined)
        #expect(ShannonMemoryOverview.mood(for: proud).cause == "生成した応答の内容と会話文脈")

        object["presence"] = [
            "mood": ["expression": "calm", "cause": "特に強い気持ちは続いていない", "fromConversation": false],
            "temperamentReasons": ["closeness": "", "curiosity": "", "confidenceAboutUser": ""],
        ]
        let settled = try OverviewFixture.decode(CompanionStateDTO.self, object)
        #expect(ShannonMemoryOverview.mood(for: settled).label == "穏やか")
        #expect(ShannonMemoryOverview.mood(for: settled).cause == nil)
    }

    @Test
    func activityGroupsSplitTodayWeekAndEarlier() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2026-09-30T12:00:00Z")!
        let items = [
            ShannonActivityItemDTO(id: "today", type: "conversation", title: "今日", detail: nil, occurredAt: "2026-09-30T08:00:00Z"),
            ShannonActivityItemDTO(id: "week", type: "sleep", title: "今週", detail: nil, occurredAt: "2026-09-27T08:00:00Z"),
            ShannonActivityItemDTO(id: "old", type: "knowledge", title: "以前", detail: nil, occurredAt: "2026-09-01T08:00:00Z"),
            ShannonActivityItemDTO(id: "bad", type: "other", title: "日付不明", detail: nil, occurredAt: "unknown"),
        ]
        let groups = ShannonMemoryOverview.activityGroups(items, now: now, calendar: calendar)
        #expect(groups.map(\.title) == ["今日", "今週", "それ以前"])
        #expect(groups.map { $0.items.map(\.id) } == [["today"], ["week"], ["old", "bad"]])
        #expect(ShannonMemoryOverview.activityGroups([], now: now, calendar: calendar).isEmpty)
    }

    @Test
    func knowledgeCategoriesKeepTheFixedOrder() throws {
        let answers = try ["その他", "興味", "基本情報", "独自", "趣味嗜好"].enumerated().map { index, category in
            try OverviewFixture.answer(id: "a\(index)", category: category)
        }
        #expect(ShannonMemoryOverview.knowledgeCategories(answers).map(\.category)
            == ["基本情報", "趣味嗜好", "興味", "その他", "独自"])
    }

    @Test
    func diaryTextPrefersInterestThenLearnedAndHasAQuietFallback() throws {
        let report = try OverviewFixture.dashboard().sleepReports[0]
        #expect(report.diaryTitle == "星の写真")
        #expect(report.diarySummary == "「星の写真」が、今日は少し心に残った。")
        let quiet = ShannonSleepReportDTO(
            dayKey: "2026-09-29", completedAt: "2026-09-29T20:00:00Z",
            learned: [], updated: [], interestChanges: [], contradictions: []
        )
        #expect(quiet.diaryTitle == "静かに整理した夜")
        #expect(!quiet.diarySummary.isEmpty)
    }

#if os(macOS)
    /// Native List/NavigationLink need an app host; render the app-owned row
    /// content of the iPhone overview for visual review only.
    @MainActor
    @Test(.enabled(if: ProcessInfo.processInfo.environment["SHANNON_RENDER_MEMORY_REVIEW"] == "1"))
    func renderOverviewRowsInLightDarkAndLargeText() throws {
        let overview = ShannonMemoryOverview(dashboard: try OverviewFixture.dashboard(), cognition: OverviewFixture.cognition())
        let loading = ShannonMemoryOverview(dashboard: nil, cognition: .empty, isLoading: true)
        let report = try OverviewFixture.dashboard().sleepReports[0]
        let directory = ProcessInfo.processInfo.environment["SHANNON_MEMORY_EVIDENCE_DIR"] ?? "/tmp"
        for (name, scheme, size) in [("light", ColorScheme.light, DynamicTypeSize.large),
                                    ("dark", .dark, .large), ("large-text", .light, .accessibility2)] {
            let palette = ShannonPalette.resolve(scheme)
            let content = VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    ShannonMemoryNowHeader(overview: overview, isLoading: false, palette: palette)
                    Text("続けている目的").font(.caption.weight(.semibold)).foregroundStyle(palette.textSecondary)
                    ForEach(overview.featuredIntents) { intent in
                        ShannonMemoryIntentPill(title: intent.title, detail: intent.nextStep.map { "次の一手：\($0)" }, palette: palette)
                    }
                }
                .padding(ShannonSpacing.large)
                .background(palette.intelligenceSoft.opacity(scheme == .dark ? 0.7 : 0.55),
                            in: RoundedRectangle(cornerRadius: ShannonShape.large))
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    ForEach(ShannonMemoryOverview.Category.allCases) { category in
                        ShannonMemoryCategoryRow(title: category.title, symbol: category.symbol,
                                                 value: overview.value(for: category), palette: palette)
                    }
                    ShannonMemoryCategoryRow(title: "日記", symbol: "book.closed",
                                             value: loading.value(for: .diary), palette: palette)
                    ShannonMemoryManagementRow(summary: overview.managementSummary, palette: palette)
                    ShannonMemoryCategoryRow(title: "使用量と活動", symbol: "gauge.with.dots.needle.50percent",
                                             value: overview.usageAndActivityValue, palette: palette)
                }
                .padding(ShannonSpacing.large)
                .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large))
                ShannonDiaryRow(report: report, palette: palette)
            }
            .padding(ShannonSpacing.large)
            .frame(width: 430)
            .background(palette.canvas)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let cg = try #require(renderer.cgImage)
            #expect(cg.width == 860)
            let png = try #require(NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("memory-overview-rows-\(name).png"))
        }
    }
#endif
}

enum OverviewFixture {
    static func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    static func stateObject(
        curiosity: Double = 0.9, openness: Double = 0.4, arousal: Double = 0.3,
        calmness: Double = 0.2, closeness: Double = 0.1, interests: [String] = ["星空"]
    ) -> [String: Any] {
        [
            "scopeKey": "fixture", "version": 2, "updatedAt": "2026-09-30T00:00:00Z",
            "temperament": ["curiosity": curiosity, "initiative": 0.5, "closeness": closeness,
                            "calmness": calmness, "needForContinuity": 0.5, "confidenceAboutUser": 0.5],
            "emotion": ["valence": 0.2, "arousal": arousal, "openness": openness],
            "interests": interests, "userFacts": [],
            "activeMemories": [["id": "m1", "summary": "旅行の写真の話", "relevance": 0.9, "observedAt": "2026-09-30T00:00:00Z"]],
        ]
    }

    static func state(
        curiosity: Double, openness: Double, arousal: Double, calmness: Double, closeness: Double
    ) throws -> CompanionStateDTO {
        try decode(CompanionStateDTO.self, stateObject(
            curiosity: curiosity, openness: openness, arousal: arousal, calmness: calmness, closeness: closeness
        ))
    }

    static func answerObject(id: String, category: String) -> [String: Any] {
        ["answerId": id, "questionKey": id, "question": "質問\(id)", "answer": "回答\(id)", "category": category,
         "source": "conversation", "confidence": 0.8, "confirmed": false,
         "updatedAt": "2026-09-30T00:00:00Z", "evidence": []]
    }

    static func answer(id: String, category: String) throws -> ShannonKnowledgeAnswerDTO {
        try decode(ShannonKnowledgeAnswerDTO.self, answerObject(id: id, category: category))
    }

    static func dashboard(
        knowledge: Bool = true, profile: Bool = true, interests: [String]? = ["星空"], dailyMind: Bool = true
    ) throws -> ShannonMemoryDashboardDTO {
        func item(_ id: String, kind: String, status: String = "active", commitment: String? = nil) -> [String: Any] {
            var value: [String: Any] = ["id": id, "kind": kind, "text": "合成\(id)", "status": status, "pinned": false,
                                        "createdAt": "2026-09-30T00:00:00Z", "updatedAt": "2026-09-30T00:00:00Z",
                                        "changeReason": "合成fixture", "evidence": []]
            if let commitment { value["commitment"] = ["status": commitment, "dueDate": "2026-10-01"] }
            return value
        }
        var interestItem = item("interest", kind: "interest")
        interestItem["text"] = "合成の興味メモ"
        var object: [String: Any] = [
            "generatedAt": "2026-09-30T00:00:00Z",
            "items": [
                item("promise", kind: "experience", commitment: "pending"),
                item("done", kind: "experience", commitment: "completed"),
                item("fact", kind: "user-fact"),
                item("relationship", kind: "relationship"),
                item("forgotten-relationship", kind: "relationship", status: "forgotten"),
                interestItem,
            ],
            "sleepReports": [[
                "dayKey": "2026-09-29", "completedAt": "2026-09-29T20:00:00Z",
                "learned": [["kind": "user-fact", "memoryId": "fact", "text": "早起き", "reason": "会話"]],
                "updated": [],
                "interestChanges": [["kind": "interest", "memoryId": "interest", "text": "星の写真", "reason": "会話"]],
                "contradictions": [],
            ]],
            "world": [
                ["id": "w1", "sourceId": "s", "sourceTitle": "合成ニュース", "title": "記事1", "url": "https://example.com/1", "discoveredAt": "2026-09-30T00:00:00Z"],
                ["id": "w2", "sourceId": "s", "sourceTitle": "合成ニュース", "title": "記事2", "url": "https://example.com/2", "discoveredAt": "2026-09-30T00:00:00Z"],
            ],
            "usage": ["monthKey": "2026-09", "estimatedCostUsd": 1.5, "backgroundCostUsd": 0.5,
                      "backgroundBudgetUsd": 2, "backgroundRemainingUsd": 1.5, "rows": []],
            "activity": [["id": "a1", "type": "conversation", "title": "会話", "occurredAt": "2026-09-30T00:00:00Z"]],
        ]
        if let interests { object["currentState"] = stateObject(interests: interests) }
        if knowledge {
            object["knowledge"] = [answerObject(id: "k1", category: "基本情報"), answerObject(id: "k2", category: "趣味嗜好")]
        }
        if profile { object["personalityProfile"] = ["version": 3, "analysis": "合成の分析", "createdAt": "2026-09-30T00:00:00Z"] }
        if dailyMind {
            object["dailyMind"] = ["scopeKey": "fixture", "dayKey": "2026-09-30", "topic": " 雨の日の散歩 ", "reason": "合成",
                                   "createdAt": "2026-09-30T00:00:00Z", "expiresAt": "2026-10-01T00:00:00Z"]
        }
        return try decode(ShannonMemoryDashboardDTO.self, object)
    }

    static func intent(_ id: String, status: ShannonCognitiveIntentStatusDTO, priority: Double) -> ShannonCognitiveIntentDTO {
        ShannonCognitiveIntentDTO(
            id: id, title: "目的\(id)", desiredOutcome: "成果\(id)", status: status, source: "explicit-user-goal",
            nextStep: "次\(id)", priority: priority, confidence: 0.9,
            createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z"
        )
    }

    static func cognition(activeCount: Int = 3) -> ShannonCognitionDashboardDTO {
        let active = (1...activeCount).map { intent("active-\($0)", status: .active, priority: Double($0) / 10) }
        return ShannonCognitionDashboardDTO(
            intents: active + [
                intent("paused", status: .paused, priority: 0.9),
                intent("completed", status: .completed, priority: 0.9),
                intent("dismissed", status: .dismissed, priority: 0.9),
            ],
            recentCycles: []
        )
    }
}
