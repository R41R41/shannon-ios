import XCTest
@testable import ShannonAppCore

final class ShannonCodeSyntaxTests: XCTestCase {
    func testHighlightsSwiftKeywordsTypesStringsNumbersAndComments() {
        let lines = ShannonCodeSyntax.tokenize("let name: String = \"hi\" // note\nreturn 42", language: "swift")
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(tone(of: "let", in: lines[0]), .keyword)
        XCTAssertEqual(tone(of: "String", in: lines[0]), .type)
        XCTAssertEqual(tone(of: "\"hi\"", in: lines[0]), .string)
        XCTAssertEqual(tone(of: "// note", in: lines[0]), .comment)
        XCTAssertEqual(tone(of: "42", in: lines[1]), .number)
    }

    func testCarriesBlockCommentAcrossLines() {
        let lines = ShannonCodeSyntax.tokenize("/* start\nstill comment */ let a", language: "ts")
        XCTAssertEqual(tone(of: "still comment */", in: lines[1]), .comment)
        XCTAssertEqual(tone(of: "let", in: lines[1]), .keyword)
    }

    func testShellHashIsCommentOnlyAtWordBoundary() {
        let lines = ShannonCodeSyntax.tokenize("echo a#b # tail", language: "bash")
        XCTAssertEqual(tone(of: "# tail", in: lines[0]), .comment)
        XCTAssertNil(tone(of: "a#b # tail", in: lines[0]))
    }

    func testUnknownLanguageStaysUncolored() {
        let lines = ShannonCodeSyntax.tokenize("let x = 1\n<div>", language: "html")
        XCTAssertTrue(lines.allSatisfy { $0.allSatisfy { $0.tone == .plain } })
        XCTAssertEqual(ShannonCodeSyntax.displayName(for: "html"), "HTML")
        XCTAssertTrue(ShannonCodeSyntax.tokenize("x", language: nil)[0].allSatisfy { $0.tone == .plain })
    }

    func testTokenizationPreservesText() {
        let source = "const s = `a ${b}`; // x\n\nfoo(0x1F)"
        let rebuilt = ShannonCodeSyntax.tokenize(source, language: "js")
            .map { $0.map(\.text).joined() }
            .joined(separator: "\n")
        XCTAssertEqual(rebuilt, source)
    }

    func testCollapseRulesHideOnlyMeaningfulRemainders() {
        XCTAssertFalse(ShannonCodeBlockLayout.isCollapsible(lineCount: 14))
        XCTAssertTrue(ShannonCodeBlockLayout.isCollapsible(lineCount: 15))
        XCTAssertEqual(ShannonCodeBlockLayout.hiddenLineCount(lineCount: 20, isExpanded: false), 8)
        XCTAssertEqual(ShannonCodeBlockLayout.hiddenLineCount(lineCount: 20, isExpanded: true), 0)
        XCTAssertEqual(ShannonCodeBlockLayout.accessibilityLabel(language: "py", lineCount: 3), "Pythonのコード、3行")
    }

    func testThinkingElapsedLabelWaitsForFirstSecond() {
        let start = Date(timeIntervalSince1970: 100)
        XCTAssertNil(ShannonThinkingElapsed.label(seconds: ShannonThinkingElapsed.seconds(since: start, now: start)))
        XCTAssertEqual(ShannonThinkingElapsed.label(seconds: ShannonThinkingElapsed.seconds(
            since: start, now: start.addingTimeInterval(7.9)
        )), "7秒")
    }

    private func tone(of text: String, in tokens: [ShannonCodeSyntax.Token]) -> ShannonCodeSyntax.Tone? {
        tokens.first { $0.text == text }?.tone
    }
}

final class ShannonAgentPlanTimelineTests: XCTestCase {
    func testUsesPlanStatusOnlyAndAttachesDurableDetailsToRunningStep() {
        var task = ShannonAgentTask(
            conversationThreadID: "t",
            title: "画面を直す",
            goal: "g",
            status: .running,
            summary: "テストはすべて完了しました",
            plan: [
                .init(id: "a", title: "調べる", status: .completed),
                .init(id: "b", title: "直す", status: .running),
                .init(id: "c", title: "確かめる", status: .pending),
            ]
        )
        task.timeline = [
            .init(sequence: 1, title: "swift test", tone: .progress, activity: .init(kind: .command, status: .failed)),
            .init(sequence: 2, title: "修正を適用", detail: "2ファイル", tone: .neutral),
        ]
        task.tests = [
            .init(name: "unit", status: .passed),
            .init(name: "ui", status: .failed),
        ]

        let entries = ShannonAgentPlanTimeline.entries(for: task)
        XCTAssertEqual(entries.map(\.status), [.completed, .running, .pending])
        XCTAssertEqual(entries.map(\.number), [1, 2, 3])
        XCTAssertTrue(entries[0].details.isEmpty)
        XCTAssertTrue(entries[2].details.isEmpty)
        XCTAssertEqual(entries[1].details.map(\.kind), [.command, .event, .verification])
        XCTAssertEqual(entries[1].details[0].title, "コマンドで問題を検出")
        XCTAssertEqual(entries[1].details[2].title, "検証 · 成功1件・失敗1件")
        XCTAssertEqual(entries[1].details[2].text, "失敗: ui")
        XCTAssertTrue(entries[2].isLast)
        XCTAssertEqual(ShannonAgentPlanTimeline.summary(for: task), "全3工程中 1工程完了")
    }

    func testNoRunningStepMeansNoDetails() {
        let task = ShannonAgentTask(
            conversationThreadID: "t",
            title: "x",
            goal: "g",
            status: .running,
            summary: "",
            plan: [.init(id: "a", title: "a", status: .pending)],
            timeline: [.init(sequence: 1, title: "e")]
        )
        XCTAssertTrue(ShannonAgentPlanTimeline.entries(for: task).allSatisfy { $0.details.isEmpty })
    }
}

final class ShannonPromptSuggestionsTests: XCTestCase {
    func testFallsBackToThreeFixedSuggestions() {
        let suggestions = ShannonPromptSuggestions.make(dailyMindTopic: nil, activeTaskTitles: [], interests: [" "])
        XCTAssertEqual(suggestions, ShannonPromptSuggestions.fallback)
        XCTAssertEqual(suggestions.count, 3)
    }

    func testBuildsFromLoadedStateAndFillsToThree() {
        let suggestions = ShannonPromptSuggestions.make(
            dailyMindTopic: "宇宙の天気",
            activeTaskTitles: ["Now画面を実装"],
            interests: []
        )
        XCTAssertEqual(suggestions.map(\.source), [.dailyMind, .activeTask, .fallback])
        XCTAssertEqual(suggestions[0].text, "「宇宙の天気」について話したい")
        XCTAssertEqual(suggestions[1].text, "「Now画面を実装」の進み具合を教えて")
    }

    func testCapsCountAndTruncatesLongTitles() {
        let suggestions = ShannonPromptSuggestions.make(
            dailyMindTopic: "話題",
            activeTaskTitles: [String(repeating: "長", count: 40)],
            interests: ["音楽", "写真", "料理"]
        )
        XCTAssertEqual(suggestions.count, ShannonPromptSuggestions.maximumCount)
        XCTAssertTrue(suggestions[1].text.contains("…"))
        XCTAssertFalse(suggestions.contains { $0.text.contains("料理") })
    }
}

final class ShannonHoldToConfirmPolicyTests: XCTestCase {
    func testFrequentOneOffApprovalsStayTapWhileScopeWideningNeedsHold() {
        XCTAssertFalse(ShannonAgentApprovalKind.command.requiresHoldToConfirm(.once))
        XCTAssertFalse(ShannonAgentApprovalKind.fileChange.requiresHoldToConfirm(.once))
        XCTAssertTrue(ShannonAgentApprovalKind.network.requiresHoldToConfirm(.once))
        XCTAssertTrue(ShannonAgentApprovalKind.permission.requiresHoldToConfirm(.once))
        for kind in [ShannonAgentApprovalKind.command, .fileChange, .network, .permission] {
            XCTAssertTrue(kind.requiresHoldToConfirm(.session))
        }
    }

    func testHoldProgressIsBoundedAndIdleWithoutPress() {
        let start = Date(timeIntervalSince1970: 10)
        XCTAssertEqual(ShannonHoldToConfirm.progress(startedAt: nil, now: start), 0)
        XCTAssertEqual(ShannonHoldToConfirm.progress(startedAt: start, now: start.addingTimeInterval(0.3)), 0.5, accuracy: 0.001)
        XCTAssertEqual(ShannonHoldToConfirm.progress(startedAt: start, now: start.addingTimeInterval(5)), 1)
        XCTAssertEqual(ShannonHoldToConfirm.progress(startedAt: start, now: start.addingTimeInterval(-1)), 0)
    }
}
