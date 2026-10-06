#if os(macOS)
import CryptoKit
import Foundation
import XCTest
@testable import ShannonAppCore

/// Roadmap A18 S3: her folder on the Mac, changing it (`docs/host-folder-contract.md`, v2 `create`, `update`, `move`,
/// `delete`). On a real temporary folder: the trash before every overwrite and delete, conflicts, the totals, the fence,
/// and the shapes the server checks.
final class ShannonFolderHostWriteTests: XCTestCase {
    private var base: URL!
    private var folder: URL!
    private var outside: URL!
    private let now = Date(timeIntervalSince1970: 1_791_200_000)

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("shannon-folder-write-\(UUID().uuidString)", isDirectory: true)
        folder = base.appendingPathComponent("シャノン用", isDirectory: true)
        outside = base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try ShannonFolderHostAdoption.adopt(folder)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    private func root() throws -> ShannonFolderHostRoot { try ShannonFolderHostRoot(folder: folder) }

    private func write(_ relative: String, _ data: Data) throws {
        let url = folder.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private func text(_ relative: String) throws -> String {
        try String(contentsOf: folder.appendingPathComponent(relative), encoding: .utf8)
    }

    private func exists(_ relative: String) -> Bool {
        FileManager.default.fileExists(atPath: folder.appendingPathComponent(relative).path)
    }

    private func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func refusal(_ body: () throws -> Void) -> ShannonFolderHostCode? {
        do { try body(); return nil } catch let refusal as ShannonFolderHostRefusal { return refusal.code } catch { return .unknown }
    }

    private func create(_ path: String, _ content: String, root: ShannonFolderHostRoot? = nil, quota: ShannonFolderHostWrites.Quota = .standard) throws -> ShannonFolderHostWriteResult {
        try ShannonFolderHostWrites.create(root ?? self.root(), relativePath: path, content: content, contentSha256: digest(content), bytes: content.utf8.count, quota: quota)
    }

    private func update(_ path: String, _ content: String, expected: String? = nil, quota: ShannonFolderHostWrites.Quota = .standard) throws -> ShannonFolderHostWriteResult {
        try ShannonFolderHostWrites.update(try root(), relativePath: path, content: content, contentSha256: digest(content), bytes: content.utf8.count,
                                           expectedSha256: expected, now: now, quota: quota)
    }

    // MARK: create

    func testCreateMakesParentsWritesTextAndNeverOverwrites() throws {
        let made = try create("旅/計画/宿.md", "静かな宿のこと。")
        XCTAssertEqual(made, ShannonFolderHostWriteResult(sha256: digest("静かな宿のこと。")))
        XCTAssertEqual(try text("旅/計画/宿.md"), "静かな宿のこと。")
        XCTAssertEqual(refusal { _ = try create("旅/計画/宿.md", "別の文") }, .alreadyExists)
        XCTAssertEqual(try text("旅/計画/宿.md"), "静かな宿のこと。")
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("folder.md"), withIntermediateDirectories: true)
        XCTAssertEqual(refusal { _ = try create("folder.md", "x") }, .alreadyExists)
        XCTAssertEqual(refusal { _ = try create("run.sh", "echo") }, .extensionNotAllowed)
        XCTAssertEqual(refusal { _ = try create("旅/計画/宿.md/下.md", "x") }, .notAFolder)
    }

    func testCreateChecksTheContentItWasSent() throws {
        let root = try root()
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.create(root, relativePath: "a.md", content: "本文", contentSha256: String(repeating: "0", count: 64), bytes: 6) }, .contentMismatch)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.create(root, relativePath: "a.md", content: "本文", contentSha256: digest("本文"), bytes: 5) }, .contentMismatch)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.create(root, relativePath: "a.md", content: nil, contentSha256: nil, bytes: nil) }, .contentMismatch)
        XCTAssertEqual(refusal { _ = try create("zero.txt", "a\u{0}b") }, .notText)
        XCTAssertEqual(refusal { _ = try create("big.md", String(repeating: "a", count: ShannonFolderHostLimits.fileBytes + 1)) }, .tooLarge)
        XCTAssertFalse(exists("a.md"))
        XCTAssertFalse(exists("big.md"))
    }

    func testCreateStaysInsideTheFence() throws {
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("away").path, withDestinationPath: outside.path)
        XCTAssertEqual(refusal { _ = try create("away/x.md", "x") }, .linkRefused)
        XCTAssertEqual(refusal { _ = try create(".SHANNON/trash/x.md", "x") }, .protectedPath)
        XCTAssertEqual(refusal { _ = try create("．ｓｈａｎｎｏｎ/x.md", "x") }, .protectedPath)
        XCTAssertEqual(refusal { _ = try create("../outside/x.md", "x") }, .pathNotAllowed)
        XCTAssertEqual(refusal { _ = try create("/tmp/x.md", "x") }, .pathNotAllowed)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
        // A package is one file: nothing is written into it.
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("Tool.app"), withIntermediateDirectories: true)
        XCTAssertEqual(refusal { _ = try create("Tool.app/x.md", "x") }, .notAFolder)
    }

    func testCreateRefusesBeyondTheFolderTotals() throws {
        _ = try create("one.md", "1234")
        _ = try create("two.md", "5678")
        XCTAssertEqual(refusal { _ = try create("three.md", "9", quota: .init(files: 2, bytes: 1_000)) }, .folderFull)
        XCTAssertEqual(refusal { _ = try create("three.md", "9", quota: .init(files: 10, bytes: 8)) }, .folderFull)
        XCTAssertNoThrow(try create("three.md", "9", quota: .init(files: 3, bytes: 9)))
        // The trash is behind the fence and does not count.
        _ = try ShannonFolderHostWrites.delete(try root(), relativePath: "one.md", now: now)
        XCTAssertNoThrow(try create("four.md", "0", quota: .init(files: 3, bytes: 9)))
    }

    // MARK: update

    func testUpdateMovesTheOriginalIntoTheTrashFirst() throws {
        _ = try create("notes/旅.md", "古い中身")
        let updated = try update("notes/旅.md", "新しい中身", expected: digest("古い中身"))
        XCTAssertEqual(updated.sha256, digest("新しい中身"))
        let trashed = try XCTUnwrap(updated.trashedAs)
        XCTAssertTrue(trashed.hasPrefix(".shannon/trash/"))
        XCTAssertTrue(trashed.hasSuffix("notes_旅.md"))
        XCTAssertEqual(try text("notes/旅.md"), "新しい中身")
        XCTAssertEqual(try text(trashed), "古い中身")
        // The trash is never listed, read or changed by a step.
        XCTAssertFalse(try ShannonFolderHostOperations.list(try root(), relativePath: "", recursive: true, limit: 500).entries.contains { $0.path.hasPrefix(".shannon") })
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.delete(try root(), relativePath: trashed, now: now) }, .protectedPath)
    }

    func testUpdateLeavesAFileTheOwnerChangedSinceSheReadIt() throws {
        _ = try create("a.md", "読んだ時の中身")
        try write("a.md", Data("ライ氏が直した中身".utf8))
        XCTAssertEqual(refusal { _ = try update("a.md", "ボクの中身", expected: digest("読んだ時の中身")) }, .changedSinceRead)
        XCTAssertEqual(try text("a.md"), "ライ氏が直した中身")
        let trash = folder.appendingPathComponent(".shannon/trash").path
        XCTAssertEqual((try? FileManager.default.contentsOfDirectory(atPath: trash)) ?? [], [])
        // Without a digest she overwrites, through the trash all the same.
        XCTAssertNotNil(try update("a.md", "ボクの中身").trashedAs)
    }

    func testUpdateRefusesWhatIsNotAnExistingTextFile() throws {
        XCTAssertEqual(refusal { _ = try update("missing.md", "x") }, .notFound)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("dir.md"), withIntermediateDirectories: true)
        XCTAssertEqual(refusal { _ = try update("dir.md", "x") }, .notAFile)
        try write("bad.md", Data([0x61, 0xFF]))
        XCTAssertEqual(refusal { _ = try update("bad.md", "x") }, .notText)
        try "secret".write(to: outside.appendingPathComponent("secret.md"), atomically: true, encoding: .utf8)
        try FileManager.default.linkItem(at: outside.appendingPathComponent("secret.md"), to: folder.appendingPathComponent("hard.md"))
        XCTAssertEqual(refusal { _ = try update("hard.md", "x") }, .linkRefused)
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("soft.md").path, withDestinationPath: outside.appendingPathComponent("secret.md").path)
        XCTAssertEqual(refusal { _ = try update("soft.md", "x") }, .linkRefused)
        XCTAssertEqual(try String(contentsOf: outside.appendingPathComponent("secret.md"), encoding: .utf8), "secret")
        _ = try create("small.md", "1")
        XCTAssertEqual(refusal { _ = try update("small.md", "123456789", quota: .init(files: 10, bytes: 8)) }, .folderFull)
        XCTAssertEqual(try text("small.md"), "1")
    }

    // MARK: move

    func testMoveRenamesAndMovesWithoutOverwritingAndKeepsKinds() throws {
        let root = try root()
        _ = try create("a.md", "A")
        _ = try create("b.md", "B")
        XCTAssertEqual(try ShannonFolderHostWrites.move(root, relativePath: "a.md", toRelativePath: "旅/2026/a2.txt"), ShannonFolderHostWriteResult())
        XCTAssertEqual(try text("旅/2026/a2.txt"), "A")
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "b.md", toRelativePath: "旅/2026/a2.txt") }, .alreadyExists)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "b.md", toRelativePath: "b.command") }, .extensionNotAllowed)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "missing.md", toRelativePath: "c.md") }, .notFound)
        // A file the owner placed keeps its kind.
        try write("photo.png", Data([0x89, 0x50]))
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "photo.png", toRelativePath: "photo.md") }, .extensionNotAllowed)
        XCTAssertNoThrow(try ShannonFolderHostWrites.move(root, relativePath: "photo.png", toRelativePath: "写真/photo.PNG"))
        // Folders move whole, never into themselves, never into the device's own folder.
        XCTAssertNoThrow(try ShannonFolderHostWrites.move(root, relativePath: "旅", toRelativePath: "archive/旅"))
        XCTAssertEqual(try text("archive/旅/2026/a2.txt"), "A")
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "archive", toRelativePath: "archive/inner") }, .pathNotAllowed)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "b.md", toRelativePath: ".shannon/b.md") }, .protectedPath)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: ".shannon/folder.json", toRelativePath: "folder.json") }, .protectedPath)
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("away").path, withDestinationPath: outside.path)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "b.md", toRelativePath: "away/b.md") }, .linkRefused)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.move(root, relativePath: "away", toRelativePath: "here") }, .linkRefused)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
    }

    // MARK: delete

    func testDeleteMovesFilesAndFoldersIntoTheTrashAndErasesNothing() throws {
        let root = try root()
        _ = try create("notes/a.md", "A")
        _ = try create("notes/b.md", "B")
        let file = try ShannonFolderHostWrites.delete(root, relativePath: "notes/a.md", now: now)
        XCTAssertEqual(try text(try XCTUnwrap(file.trashedAs)), "A")
        XCTAssertNil(file.sha256)
        let folderTrash = try ShannonFolderHostWrites.delete(root, relativePath: "notes", now: now)
        XCTAssertEqual(try text(try XCTUnwrap(folderTrash.trashedAs) + "/b.md"), "B")
        XCTAssertFalse(exists("notes"))
        // The same name at the same instant gets a name of its own.
        _ = try create("notes/a.md", "A2")
        let again = try ShannonFolderHostWrites.delete(root, relativePath: "notes/a.md", now: now)
        XCTAssertNotEqual(again.trashedAs, file.trashedAs)
        XCTAssertEqual(try text(try XCTUnwrap(again.trashedAs)), "A2")
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.delete(root, relativePath: "", now: now) }, .pathNotAllowed)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.delete(root, relativePath: ".shannon", now: now) }, .protectedPath)
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.delete(root, relativePath: "missing.md", now: now) }, .notFound)
        XCTAssertTrue(exists(".shannon/folder.json"))
    }

    func testALongPathStillGetsATrashNameTheDiskAndTheServerAccept() throws {
        let long = (0..<7).map { _ in String(repeating: "長", count: 28) }.joined(separator: "/") + "/末尾の名前.md"
        _ = try create(long, "x")
        let trashed = try XCTUnwrap(try ShannonFolderHostWrites.delete(try root(), relativePath: long, now: now).trashedAs)
        XCTAssertLessThanOrEqual(trashed.count, 400)
        XCTAssertTrue(trashed.hasSuffix("末尾の名前.md"))
        XCTAssertEqual(try text(trashed), "x")
    }

    // MARK: Another program swapping a folder for a link after the check

    /// Replaces the folder at `relative` with a link to `outside`, as another program could between the check and the call.
    private func swapForLink(_ relative: String) throws {
        let url = folder.appendingPathComponent(relative)
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createSymbolicLink(atPath: url.path, withDestinationPath: outside.path)
    }

    private func outsideIsEmpty() throws -> Bool { try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty }

    func testAParentSwappedForALinkAfterTheCheckIsNeverWrittenThrough() throws {
        let root = try root()
        // The new file: a link anywhere in the path, not only the last part, is refused.
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("a/b"), withIntermediateDirectories: true)
        try swapForLink("a")
        XCTAssertEqual(refusal { try ShannonFolderHostWrites.writeNew(root.path + "/a/b/x.md", Data("x".utf8)) }, .linkRefused)
        XCTAssertTrue(try outsideIsEmpty())

        // Making the parents: checked while "c" was a folder, a link when the folders are made.
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("c"), withIntermediateDirectories: true)
        let target = try root.target("c/d/x.md", kind: .file)
        try swapForLink("c")
        XCTAssertEqual(refusal { try root.makeParents(target) }, .linkRefused)
        XCTAssertTrue(try outsideIsEmpty())
    }

    func testAMoveOrATrashingThroughASwappedFolderIsRefused() throws {
        let root = try root()
        try "secret".write(to: outside.appendingPathComponent("s.md"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("away").path, withDestinationPath: outside.path)
        // Trashing (delete and update) of an entry whose folder became a link: the outside file stays where it is.
        XCTAssertEqual(refusal { _ = try root.trash(root.path + "/away/s.md", relative: "away/s.md", now: now) }, .linkRefused)
        XCTAssertEqual(try String(contentsOf: outside.appendingPathComponent("s.md"), encoding: .utf8), "secret")
        // A trash swapped for a link is never used: the file stays in place.
        _ = try create("keep.md", "keep")
        try FileManager.default.createDirectory(at: folder.appendingPathComponent(".shannon/trash"), withIntermediateDirectories: true)
        try swapForLink(".shannon/trash")
        XCTAssertEqual(refusal { _ = try ShannonFolderHostWrites.delete(root, relativePath: "keep.md", now: now) }, .linkRefused)
        XCTAssertEqual(try text("keep.md"), "keep")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), ["s.md"])
    }

    // MARK: The worker, the log and the wire

    func testTheWorkerChangesTheFolderButNeverTakesAV1Copy() async throws {
        let worker = ShannonFolderHostWorker(now: { [now] in now })
        await worker.setFolder(folder)
        let content = "ボクのメモ"
        let created = await worker.perform(.init(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21", operation: "create", relativePath: "memo.md",
                                                 content: content, contentSha256: digest(content), bytes: content.utf8.count), stopped: false)
        XCTAssertEqual(created, .done(.write(.init(sha256: digest(content)))))
        let copy = await worker.perform(.init(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c22", operation: "write", relativePath: "notes/note-2026-10-02-1a2b3c4d-v1.md",
                                              content: content, contentSha256: digest(content), bytes: content.utf8.count), stopped: false)
        XCTAssertEqual(copy, .refused(.init(.unsupportedOperation)))
        XCTAssertFalse(exists("notes"))
        XCTAssertFalse(ShannonFolderHostWire.operations.contains("write"))
        XCTAssertEqual(ShannonFolderHostClaimRequest(scopeKey: "owner", host: "owner-mac", localStop: false).operations,
                       ["list", "read", "search", "create", "update", "move", "delete"])
        let stopped = await worker.perform(.init(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c23", operation: "delete", relativePath: "memo.md"), stopped: true)
        XCTAssertEqual(stopped, .refused(.init(.stoppedLocally)))
        XCTAssertTrue(exists("memo.md"))

        // The log line says what was done and where the old one went, never what was written.
        let moveStep = ShannonFolderHostStep(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c24", operation: "move", relativePath: "memo.md", toRelativePath: "memo2.md")
        let moved = await worker.perform(moveStep, stopped: false)
        let moveLine = ShannonFolderHostLogEntry(step: moveStep, report: moved, at: now)
        XCTAssertEqual(moveLine.to, "memo2.md")
        let updateStep = ShannonFolderHostStep(id: "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c25", operation: "update", relativePath: "memo2.md",
                                               content: "秘密の新しい中身", contentSha256: digest("秘密の新しい中身"), bytes: "秘密の新しい中身".utf8.count)
        let updated = await worker.perform(updateStep, stopped: false)
        let updateLine = ShannonFolderHostLogEntry(step: updateStep, report: updated, at: now)
        XCTAssertNotNil(updateLine.trashedAs)
        XCTAssertEqual(updateLine.count, "秘密の新しい中身".utf8.count)
        let encoded = String(decoding: try JSONEncoder().encode(updateLine), as: UTF8.self)
        XCTAssertFalse(encoded.contains("秘密"))
        XCTAssertFalse(encoded.contains(digest("秘密の新しい中身")))
    }

    func testWriteReportsCarryOnlyTheFieldsTheServerAccepts() throws {
        // The update step of `hostFolderOperations.test.ts`.
        let json = #"{"id":"8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21","operation":"update","relativePath":"notes/旅.md","content":"新しい中身","contentSha256":"\#(digest("新しい中身"))","bytes":15,"expectedSha256":"\#(digest("古い"))","expiresAt":"2026-10-05T03:00:15.000Z"}"#
        let step = try JSONDecoder().decode(ShannonFolderHostStep.self, from: Data(json.utf8))
        XCTAssertEqual(step.operation, "update")
        XCTAssertEqual(step.bytes, 15)
        XCTAssertEqual(step.expectedSha256, digest("古い"))
        let moveJSON = #"{"id":"8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c22","operation":"move","relativePath":"a.md","toRelativePath":"b/a.md","expiresAt":"2026-10-05T03:00:15.000Z"}"#
        XCTAssertEqual(try JSONDecoder().decode(ShannonFolderHostStep.self, from: Data(moveJSON.utf8)).toRelativePath, "b/a.md")

        func result(_ write: ShannonFolderHostWriteResult) throws -> [String: Any] {
            let body = try JSONSerialization.jsonObject(with: ShannonFolderHostReport.done(.write(write)).body(scopeKey: "owner")) as! [String: Any]
            XCTAssertEqual(Set(body.keys), ["scopeKey", "outcome", "result"])
            return body["result"] as! [String: Any]
        }
        XCTAssertEqual(Set(try result(.init(sha256: digest("x"))).keys), ["sha256"])
        XCTAssertEqual(Set(try result(.init(sha256: digest("x"), trashedAs: ".shannon/trash/1_a.md")).keys), ["sha256", "trashedAs"])
        XCTAssertEqual(Set(try result(.init()).keys), [])
        XCTAssertEqual(Set(try result(.init(trashedAs: ".shannon/trash/1_a.md")).keys), ["trashedAs"])
        let conflict = try JSONSerialization.jsonObject(with: ShannonFolderHostReport.refused(.init(.changedSinceRead)).body(scopeKey: "owner")) as! [String: Any]
        XCTAssertEqual(conflict as NSDictionary, ["scopeKey": "owner", "outcome": "refused", "code": "changed_since_read"] as NSDictionary)
    }
}
#endif
