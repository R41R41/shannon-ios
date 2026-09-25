import Foundation
import SwiftUI
import Testing
@testable import ShannonAppCore
#if os(macOS)
import AppKit
#endif

@MainActor
struct ShannonMemoryLibraryTests {
    @Test(arguments: [false, true])
    func managementIncludesEveryItemRegardlessOfOverviewData(rich: Bool) throws {
        let dashboard = try LibraryFixture.dashboard(rich: rich)
        let library = ShannonMemoryLibrary(dashboard: dashboard)
        let routedIDs = ShannonMemoryLibrary.SectionID.allCases.flatMap { library.items(in: $0).map(\.id) }
        #expect(Set(routedIDs) == Set(dashboard.items.map(\.id)))
        #expect(routedIDs.count == dashboard.items.count)
        #expect(library.items(in: .pending).map(\.id) == ["promise"])
        #expect(library.items(in: .closed).map(\.id) == ["completed"])
        #expect(library.items(in: .hidden).map(\.id) == ["forgotten", "rejected"])
    }

    @Test
    func emptyAndNotLoadedDashboardsKeepAllManagementSections() {
        let library = ShannonMemoryLibrary(dashboard: nil)
        #expect(ShannonMemoryLibrary.SectionID.allCases.count == 4)
        #expect(ShannonMemoryLibrary.SectionID.allCases.allSatisfy { library.items(in: $0).isEmpty })
        #expect(!library.summary.isEmpty)
    }

    @Test
    func failedReloadAndMutationKeepTheLastReachableItems() async throws {
        let client = try LibraryFixtureClient()
        let model = ShannonMemoryModel(client: client)
        await model.loadIfNeeded()
        let before = ShannonMemoryLibrary(dashboard: model.dashboard)
        let promise = try #require(before.items(in: .pending).first)
        await client.setUnavailable(true)
        await model.reload()
        #expect(model.errorMessage != nil)
        #expect(ShannonMemoryLibrary(dashboard: model.dashboard) == before)
        #expect(!(await model.act(on: promise, action: .complete)))
        #expect(model.errorMessage != nil)
        #expect(ShannonMemoryLibrary(dashboard: model.dashboard) == before)
        #expect(model.mutatingMemoryID == nil)
        await client.setUnavailable(false)
        await model.reload()
        #expect(model.errorMessage == nil)
        #expect(ShannonMemoryLibrary(dashboard: model.dashboard) == before)
    }

    @Test(arguments: [ShannonMemoryActionDTO.complete, .dismiss, .correct, .forget, .reject])
    func durableMutationRemainsReachableAfterReload(action: ShannonMemoryActionDTO) async throws {
        let client = try LibraryFixtureClient()
        let model = ShannonMemoryModel(client: client)
        await model.loadIfNeeded()
        let promise = try #require(model.dashboard?.items.first { $0.id == "promise" })
        #expect(await model.act(on: promise, action: action, text: "訂正した約束"))
        await model.reload()
        let library = ShannonMemoryLibrary(dashboard: model.dashboard)
        let expectedSection: ShannonMemoryLibrary.SectionID = switch action {
        case .complete, .dismiss: .closed
        case .forget, .reject: .hidden
        default: .pending
        }
        let routed = try #require(library.items(in: expectedSection).first { $0.id == promise.id })
        if action == .correct { #expect(routed.text == "訂正した約束") }
        if action == .forget || action == .reject {
            #expect(await model.act(on: routed, action: .restore))
            await model.reload()
            #expect(ShannonMemoryLibrary(dashboard: model.dashboard).items(in: .pending).contains { $0.id == promise.id })
        }
    }

#if os(macOS)
    @Test(.enabled(if: ProcessInfo.processInfo.environment["SHANNON_RENDER_MEMORY_REVIEW"] == "1"),
          arguments: [false, true])
    func renderActualParentInLightDarkAndLargeText(rich: Bool) async throws {
        let model = ShannonMemoryModel(client: try LibraryFixtureClient(rich: rich))
        await model.loadIfNeeded()
        let directory = ProcessInfo.processInfo.environment["SHANNON_MEMORY_EVIDENCE_DIR"] ?? "/tmp"
        for (name, scheme, size) in [("light", ColorScheme.light, DynamicTypeSize.large),
                                    ("dark", .dark, .large), ("large-text", .light, .accessibility2)] {
            let palette = ShannonPalette.resolve(scheme)
            // The same composition used by the actual parent, without the
            // native scrolling/lazy container that ImageRenderer cannot draw.
            let content = VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                ShannonMemoryView(model: model).overviewContent(palette)
            }
                .padding(ShannonSpacing.large)
                .frame(width: 430)
                .background(palette.readingSurface)
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let cg = try #require(renderer.cgImage)
            #expect(cg.width == 860)
            #expect(cg.height > 300)
            let renderedPixels = try #require(cg.dataProvider?.data) as Data
            #expect(Set(renderedPixels).count > 16, "A blank image is not UI evidence")
            let bitmap = NSBitmapImageRep(cgImage: cg)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("memory-parent-\(rich ? "rich" : "sparse")-\(name).png"))
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["SHANNON_RENDER_MEMORY_REVIEW"] == "1"))
    func renderManagementComponents() throws {
        let library = ShannonMemoryLibrary(dashboard: try LibraryFixture.dashboard())
        let directory = ProcessInfo.processInfo.environment["SHANNON_MEMORY_EVIDENCE_DIR"] ?? "/tmp"
        for (name, scheme) in [("light", ColorScheme.light), ("dark", .dark)] {
            let palette = ShannonPalette.resolve(scheme)
            // Native List/Picker/NavigationStack need an app host. Render their
            // actual app-owned labels/rows separately for visual inspection.
            let content = VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                ShannonMemoryManagementLabel(summary: library.summary, palette: palette)
                ForEach(ShannonMemoryLibrary.SectionID.allCases) { section in
                    Text(section.title).font(.headline).foregroundStyle(palette.textSecondary)
                    ForEach(library.items(in: section)) { item in
                        ShannonMemoryLibraryRow(item: item, palette: palette)
                    }
                    Divider()
                }
            }
            .padding(ShannonSpacing.large)
            .frame(width: 430)
            .background(palette.readingSurface)
            .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let cg = try #require(renderer.cgImage)
            let png = try #require(NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("memory-management-components-\(name).png"))
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["SHANNON_RENDER_MEMORY_REVIEW"] == "1"))
    func renderCognitionComponentsInLightDarkAndLargeText() throws {
        let dashboard = LibraryFixture.cognition()
        let intent = try #require(dashboard.intents.first)
        let cycle = try #require(dashboard.recentCycles.first)
        let directory = ProcessInfo.processInfo.environment["SHANNON_MEMORY_EVIDENCE_DIR"] ?? "/tmp"
        for (name, scheme, size) in [("light", ColorScheme.light, ContentSizeCategory.large),
                                    ("dark", .dark, .large),
                                    ("large-text", .light, .accessibilityExtraExtraExtraLarge)] {
            let palette = ShannonPalette.resolve(scheme)
            let content = VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                ShannonCognitionManagementLabel(
                    cognition: dashboard,
                    isLoading: false,
                    hasError: false,
                    palette: palette
                )
                // ImageRenderer cannot host a native Menu. Keep the exact
                // app-owned row content and render its menu label statically.
                ShannonCognitiveIntentRow(
                    intent: intent,
                    isUpdating: false,
                    palette: palette,
                    showsActionMenu: false
                ) { _ in }
                Divider()
                ShannonCognitiveCycleRow(cycle: cycle, palette: palette)
            }
            .padding(ShannonSpacing.large)
            .frame(width: 430)
            .background(palette.readingSurface)
            .environment(\.colorScheme, scheme)
            .environment(\.sizeCategory, size)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let cg = try #require(renderer.cgImage)
            #expect(cg.width == 860)
            #expect(cg.height > 300)
            let png = try #require(NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("memory-cognition-components-\(name).png"))
        }
    }
#endif
}

private enum LibraryFixture {
    static func cognition(rich: Bool = true) -> ShannonCognitionDashboardDTO {
        guard rich else { return .empty }
        let intent = ShannonCognitiveIntentDTO(
            id: "goal-voice",
            title: "自然な音声対話を育てる",
            desiredOutcome: "場所や記憶を使いながら自然な日本語で話せるようにする",
            status: .active,
            source: "explicit-user-goal",
            sourceExperienceId: nil,
            threadId: "fixture-thread",
            nextStep: "音声と現在地を組み合わせて確認する",
            planSteps: ["現在地を会話へ渡す", "交通検索を試す", "実機で自然さを確認する"],
            linkedTaskId: "task-voice",
            verifiedWork: ShannonVerifiedWorkDTO(
                taskId: "task-voice",
                title: "音声・現在地連携の改善",
                status: "running",
                summary: "実装済みの経路を端末で検証している",
                currentAction: "交通検索を含む音声ターンを確認中",
                plan: [
                    ShannonVerifiedWorkPlanItemDTO(title: "現在地を会話へ渡す", status: "completed"),
                    ShannonVerifiedWorkPlanItemDTO(title: "交通検索を試す", status: "running"),
                    ShannonVerifiedWorkPlanItemDTO(title: "実機で自然さを確認する", status: "pending"),
                ],
                completedPlanSteps: 1,
                totalPlanSteps: 3,
                testsPassed: 2,
                testsFailed: 0,
                updatedAt: "2026-09-25T08:00:00Z"
            ),
            priority: 0.8,
            confidence: 0.95,
            createdAt: "2026-09-24T12:00:00Z",
            updatedAt: "2026-09-25T08:00:00Z"
        )
        let cycle = ShannonCognitiveCycleDTO(
            id: "cycle-voice",
            threadId: "fixture-thread",
            channel: "voice",
            primaryIntentID: intent.id,
            recalledMemoryIDs: ["remembered"],
            action: "delegate",
            outcome: "completed",
            summary: "現在地を確認して交通案内を調べた",
            occurredAt: "2026-09-25T08:01:00Z"
        )
        return ShannonCognitionDashboardDTO(intents: [intent], recentCycles: [cycle])
    }

    static func dashboard(rich: Bool = true, action: ShannonMemoryActionDTO? = nil, text: String? = nil) throws -> ShannonMemoryDashboardDTO {
        let status = action == .forget ? "forgotten" : action == .reject ? "rejected" : "active"
        let commitment = action == .complete ? "completed" : action == .dismiss ? "dismissed" : "pending"
        func item(_ id: String, status: String = "active", commitment: String? = nil) -> [String: Any] {
            var item: [String: Any] = ["id": id, "kind": "experience", "text": id == "promise" ? (text ?? "旅行の写真を整理する約束") : "合成記憶 \(id)", "status": status, "pinned": false,
                                      "createdAt": "2026-09-24T12:00:00Z", "updatedAt": "2026-09-24T12:00:00Z", "changeReason": "合成fixture", "evidence": []]
            if let commitment { item["commitment"] = ["status": commitment, "dueDate": "2026-09-25", "timeZone": "Asia/Tokyo"] }
            return item
        }
        var dashboard: [String: Any] = ["generatedAt": "2026-09-24T12:00:00Z", "sleepReports": [], "items": [
            item("promise", status: status, commitment: commitment), item("completed", commitment: "completed"),
            item("remembered"), item("forgotten", status: "forgotten"), item("rejected", status: "rejected")
        ]]
        if rich {
            dashboard["activity"] = [["id": "activity", "type": "conversation", "title": "活動履歴あり", "occurredAt": "2026-09-24T12:00:00Z"]]
            dashboard["knowledge"] = [["answerId": "answer", "questionKey": "question", "question": "好みは？", "answer": "合成回答", "category": "趣味嗜好", "source": "user", "confidence": 1, "confirmed": true, "updatedAt": "2026-09-24T12:00:00Z", "evidence": []]]
            dashboard["currentState"] = ["scopeKey": "fixture", "version": 1, "updatedAt": "2026-09-24T12:00:00Z", "temperament": ["curiosity": 0.5, "initiative": 0.5, "closeness": 0.5, "calmness": 0.5, "needForContinuity": 0.5, "confidenceAboutUser": 0.5], "emotion": ["valence": 0, "arousal": 0.5, "openness": 0.5], "interests": [], "userFacts": [], "activeMemories": []]
        }
        return try JSONDecoder().decode(ShannonMemoryDashboardDTO.self, from: JSONSerialization.data(withJSONObject: dashboard))
    }
}

private actor LibraryFixtureClient: ShannonMemoryServing {
    private var dashboard: ShannonMemoryDashboardDTO
    private var cognition: ShannonCognitionDashboardDTO
    private let rich: Bool
    private var unavailable = false
    init(rich: Bool = true) throws {
        self.rich = rich
        dashboard = try LibraryFixture.dashboard(rich: rich)
        cognition = LibraryFixture.cognition(rich: rich)
    }
    func setUnavailable(_ value: Bool) { unavailable = value }
    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO {
        if unavailable { throw URLError(.notConnectedToInternet) }
        return dashboard
    }
    func mutateMemory(scopeKey: String, memoryID: String, action: ShannonMemoryActionDTO, text: String?) async throws -> ShannonMemoryDashboardDTO {
        if unavailable { throw URLError(.notConnectedToInternet) }
        dashboard = try LibraryFixture.dashboard(rich: rich, action: action, text: text)
        return dashboard
    }
    func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO { dashboard }
    func loadCognition(scopeKey: String) async throws -> ShannonCognitionDashboardDTO {
        if unavailable { throw URLError(.notConnectedToInternet) }
        return cognition
    }
    func updateCognitiveIntent(
        scopeKey: String,
        intentID: String,
        status: ShannonCognitiveIntentStatusDTO
    ) async throws -> ShannonCognitiveIntentDTO {
        if unavailable { throw URLError(.notConnectedToInternet) }
        guard let current = cognition.intents.first(where: { $0.id == intentID }) else {
            throw URLError(.resourceUnavailable)
        }
        let updated = ShannonCognitiveIntentDTO(
            id: current.id,
            title: current.title,
            desiredOutcome: current.desiredOutcome,
            status: status,
            source: current.source,
            sourceExperienceId: current.sourceExperienceId,
            threadId: current.threadId,
            nextStep: current.nextStep,
            planSteps: current.planSteps,
            priority: current.priority,
            confidence: current.confidence,
            createdAt: current.createdAt,
            updatedAt: "2026-09-25T09:00:00Z"
        )
        cognition = ShannonCognitionDashboardDTO(
            intents: cognition.intents.map { $0.id == intentID ? updated : $0 },
            recentCycles: cognition.recentCycles
        )
        return updated
    }
}
