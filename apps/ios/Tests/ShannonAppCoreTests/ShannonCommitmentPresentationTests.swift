import XCTest
import SwiftUI
@testable import ShannonAppCore
#if os(macOS)
import AppKit
#endif

@MainActor
final class ShannonCommitmentPresentationTests: XCTestCase {
    func testNewCommitmentFieldsAreAdditiveAndMutationsUseDurableResults() async throws {
        let client = CommitmentFixtureClient()
        let model = ShannonMemoryModel(client: client)
        await model.loadIfNeeded()
        let item = try XCTUnwrap(model.activeItems.first)
        XCTAssertEqual(item.kind, .experience) // Older clients can still decode this kind.
        XCTAssertEqual(item.commitment?.status, "pending")
        let succeeded = await model.act(on: item, action: .complete)
        XCTAssertTrue(succeeded)
        XCTAssertEqual(model.activeItems.first?.commitment?.status, "completed")
    }

#if os(macOS)
    func testRenderCommitmentControlsInLightDarkAndLargeText() async throws {
        guard ProcessInfo.processInfo.environment["SHANNON_RENDER_MEMORY_REVIEW"] == "1" else { return }
        let model = ShannonMemoryModel(client: CommitmentFixtureClient())
        await model.loadIfNeeded()
        let item = try XCTUnwrap(model.activeItems.first)
        let view = ShannonMemoryDetailView(model: model, memoryID: item.id)
        for (name, scheme, textSize) in [("light", ColorScheme.light, DynamicTypeSize.large),
                                        ("dark", .dark, .large), ("large-text", .light, .accessibility2)] {
            let palette = ShannonPalette.resolve(scheme)
            let rendered = VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                view.detailHeader(item, palette)
                view.actions(item, palette)
            }
            .padding(ShannonSpacing.large)
            .frame(width: 430)
            .background(palette.readingSurface)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, textSize)
            let renderer = ImageRenderer(content: rendered)
            renderer.scale = 2
            let cgImage = try XCTUnwrap(renderer.cgImage)
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try data.write(to: URL(fileURLWithPath: "/tmp/shannon-hardening-memory-\(name).png"))
            XCTAssertGreaterThan(cgImage.height, 500)
        }
    }
#endif
}

private actor CommitmentFixtureClient: ShannonAPIClientProtocol {
    private var status = "pending"
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }
    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO { try dashboard() }
    func mutateMemory(scopeKey: String, memoryID: String, action: ShannonMemoryActionDTO, text: String?) async throws -> ShannonMemoryDashboardDTO {
        if action == .complete { status = "completed" }
        if action == .dismiss { status = "dismissed" }
        return try dashboard()
    }
    private func dashboard() throws -> ShannonMemoryDashboardDTO {
        let data = Data("""
        {"generatedAt":"2026-09-24T12:00:00Z","items":[{
          "id":"promise-1","kind":"experience","text":"浜松の写真を一緒に整理する",
          "status":"active","pinned":false,"createdAt":"2026-09-24T12:00:00Z",
          "updatedAt":"2026-09-24T12:00:00Z","changeReason":"あなたとの約束","evidence":[],
          "commitment":{"status":"\(status)","dueDate":"2026-09-25","timeZone":"Asia/Tokyo"}
        }],"sleepReports":[]}
        """.utf8)
        return try JSONDecoder().decode(ShannonMemoryDashboardDTO.self, from: data)
    }
}
