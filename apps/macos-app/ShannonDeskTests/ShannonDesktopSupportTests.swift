import ShannonAppCore
import XCTest

final class ShannonDesktopWorkProjectionTests: XCTestCase {
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

    private func makeTask(
        status: ShannonAgentTaskStatus,
        updatedAt: Date = Date(),
        plan: [ShannonAgentPlanItem] = []
    ) -> ShannonAgentTask {
        ShannonAgentTask(
            conversationThreadID: "thread-test",
            title: "Mac版を仕上げる",
            goal: "Macで会話と作業を継続できる",
            status: status,
            summary: "実装を進めています",
            plan: plan,
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
    }
}
