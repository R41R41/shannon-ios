import ShannonAppCore
import XCTest

final class ShannonDesktopWorkProjectionTests: XCTestCase {
    func testThreadSearchMatchesCaseDiacriticsAndFullWidthText() {
        let threads = [
            makeThread(id: "clear", title: "Clear Signal の配色"),
            makeThread(id: "cafe", title: "Caféでのメモ"),
            makeThread(id: "other", title: "長期計画"),
        ]

        XCTAssertEqual(
            ShannonDesktopThreadSearch.matches(threads, query: "ＣＬＥＡＲ").map(\.threadId),
            ["clear"]
        )
        XCTAssertEqual(
            ShannonDesktopThreadSearch.matches(threads, query: "cafe").map(\.threadId),
            ["cafe"]
        )
    }

    func testThreadSearchPreservesServerOrderAndReturnsFirstResult() {
        let threads = [
            makeThread(id: "new", title: "Mac版 UI"),
            makeThread(id: "old", title: "Mac版 設計"),
        ]

        XCTAssertEqual(
            ShannonDesktopThreadSearch.firstResultID(in: threads, query: "Mac版"),
            "new"
        )
        XCTAssertEqual(
            ShannonDesktopThreadSearch.matches(threads, query: "  ").map(\.threadId),
            ["new", "old"]
        )
    }

    func testAttachmentLoaderReadsSupportedUTF8TextAndKeepsItsMetadata() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("notes.md")
        try Data("# 設計メモ\n本文".utf8).write(to: url)

        let loaded = try ShannonDesktopAttachmentLoader.load(urls: [url])

        XCTAssertEqual(loaded, [
            ShannonChatAttachmentDTO(name: "notes.md", mimeType: "text/markdown", text: "# 設計メモ\n本文")
        ])
    }

    func testAttachmentLoaderRejectsUnsupportedAndOversizedFiles() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("shannon-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let binary = folder.appendingPathComponent("sample.png")
        try Data([0, 1, 2]).write(to: binary)
        let large = folder.appendingPathComponent("large.txt")
        try Data(repeating: 65, count: ShannonDesktopAttachmentLimits.maximumBytesPerFile + 1).write(to: large)

        XCTAssertThrowsError(try ShannonDesktopAttachmentLoader.load(urls: [binary])) { error in
            XCTAssertEqual(error as? ShannonDesktopAttachmentError, .unsupportedType("sample.png"))
        }
        XCTAssertThrowsError(try ShannonDesktopAttachmentLoader.load(urls: [large])) { error in
            XCTAssertEqual(error as? ShannonDesktopAttachmentError, .fileTooLarge("large.txt"))
        }
    }

    @MainActor
    func testDesignPreviewThreadSwitchStaysOfflineAndClear() async {
        let model = ShannonConversationModel.designPreview()

        await model.selectThread("roadmap-preview")
        XCTAssertEqual(model.selectedThreadId, "roadmap-preview")
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.errorMessage)

        await model.selectThread("design-preview")
        XCTAssertEqual(model.messages.count, 6)
        XCTAssertNil(model.errorMessage)
    }

    func testProjectionSeparatesCurrentProposedAndFinishedWork() {
        let now = Date()
        let active = makeTask(status: .running, updatedAt: now)
        let proposed = makeTask(status: .proposed, updatedAt: now.addingTimeInterval(-10))
        let completed = makeTask(status: .completed, updatedAt: now.addingTimeInterval(-20))

        let projection = ShannonDesktopWorkProjection(tasks: [completed, proposed, active])

        XCTAssertEqual(projection.active.map(\.id), [active.id])
        XCTAssertEqual(projection.proposed.map(\.id), [proposed.id])
        XCTAssertEqual(projection.finished.map(\.id), [completed.id])
    }

    func testNextActionPrefersApprovalThenPendingPlanItem() {
        let approval = makeTask(status: .waitingApproval)
        let running = makeTask(
            status: .running,
            plan: [.init(id: "verify", title: "テストして結果をまとめる", status: .pending)]
        )

        XCTAssertEqual(
            ShannonDesktopWorkProjection.nextAction(for: approval),
            "あなたの確認後に作業を再開"
        )
        XCTAssertEqual(
            ShannonDesktopWorkProjection.nextAction(for: running),
            "テストして結果をまとめる"
        )
    }

    func testTaskConversationContextPreservesSourceAndResolvesThreadTitle() {
        let sourceMessageID = UUID()
        let task = makeTask(
            status: .running,
            conversationThreadID: "thread-work",
            sourceMessageID: sourceMessageID
        )
        let context = ShannonDesktopConversationContext(task: task)

        XCTAssertEqual(context.threadID, "thread-work")
        XCTAssertEqual(context.sourceMessageID, sourceMessageID)
        XCTAssertEqual(
            context.title(in: [makeThread(id: "thread-work", title: "Mac版を仕上げる")]),
            "Mac版を仕上げる"
        )
        XCTAssertEqual(context.title(in: []), "この作業を始めたトーク")
    }

    func testTaskActionPolicyFollowsDurableStatus() {
        let proposed = ShannonDesktopTaskActionPolicy(status: .proposed)
        XCTAssertTrue(proposed.canStart)
        XCTAssertFalse(proposed.canSteer)
        XCTAssertTrue(proposed.canCancel)

        let running = ShannonDesktopTaskActionPolicy(status: .running)
        XCTAssertTrue(running.canPause)
        XCTAssertTrue(running.canSteer)
        XCTAssertTrue(running.canCancel)

        let paused = ShannonDesktopTaskActionPolicy(status: .paused)
        XCTAssertTrue(paused.canResume)
        XCTAssertTrue(paused.canSteer)

        let completed = ShannonDesktopTaskActionPolicy(status: .completed)
        XCTAssertFalse(completed.canStart)
        XCTAssertFalse(completed.canPause)
        XCTAssertFalse(completed.canResume)
        XCTAssertFalse(completed.canSteer)
        XCTAssertFalse(completed.canCancel)
    }

    func testConversationOutlineIncludesRequestsAndMarkdownHeadings() {
        let requestID = UUID()
        let answerID = UUID()
        let messages = [
            ConversationMessage(
                id: requestID,
                role: .user,
                text: "  Mac版の作業全体を もっと分かりやすくして  "
            ),
            ConversationMessage(
                id: answerID,
                role: .shannon,
                text: "# 現在地\n本文\n## 次にやること\n```\n# コード内は除外\n```"
            ),
        ]

        let entries = ShannonDesktopConversationOutline.entries(from: messages)

        XCTAssertEqual(entries.map(\.messageID), [requestID, answerID, answerID])
        XCTAssertEqual(entries.map(\.title), [
            "Mac版の作業全体を もっと分かりやすくして",
            "現在地",
            "次にやること",
        ])
        XCTAssertEqual(entries.map(\.level), [0, 1, 2])
        XCTAssertEqual(entries.map(\.kind), [.request, .heading, .heading])
    }

    private func makeTask(
        status: ShannonAgentTaskStatus,
        updatedAt: Date = Date(),
        plan: [ShannonAgentPlanItem] = [],
        conversationThreadID: String = "thread-test",
        sourceMessageID: UUID? = nil
    ) -> ShannonAgentTask {
        ShannonAgentTask(
            conversationThreadID: conversationThreadID,
            sourceMessageID: sourceMessageID,
            title: "Mac版を仕上げる",
            goal: "Macで会話と作業を継続できる",
            status: status,
            summary: "実装を進めています",
            plan: plan,
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
    }

    private func makeThread(id: String, title: String) -> ChatThreadDTO {
        let data = try! JSONSerialization.data(withJSONObject: [
            "threadId": id,
            "title": title,
            "createdAt": "2026-09-08T00:00:00Z",
            "updatedAt": "2026-09-08T00:00:00Z",
            "messageCount": 1,
        ])
        return try! JSONDecoder().decode(ChatThreadDTO.self, from: data)
    }
}
