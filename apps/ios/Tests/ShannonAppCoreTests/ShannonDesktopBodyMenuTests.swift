#if os(macOS)
import AppKit
import XCTest
@testable import ShannonAppCore

/// Roadmap A17 and information-architecture.md 8 #27: the app has one menu bar item, and her desktop body adds the
/// app's own part to it.
final class ShannonDesktopBodyMenuTests: XCTestCase {
    @MainActor
    func testTheAppsPartOfTheOneMenuBarItem() {
        let menuBar = ShannonDesktopMenuBar()
        menuBar.makesStatusItem = false
        let body = ShannonDesktopBody()
        let section = ShannonDesktopBodyMenuSection(body: body, menuBar: menuBar)
        menuBar.register(section)
        XCTAssertTrue(menuBar.isShown)
        let titles = menuBar.currentItems().map(\.title)
        XCTAssertEqual(titles.first, ShannonGeneratedStrings.desktopBodyShow)
        XCTAssertTrue(titles.contains(ShannonGeneratedStrings.desktopBodyAlwaysOnTop))
        for entry in ShannonDesktopEntry.allCases { XCTAssertTrue(titles.contains(entry.title)) }
        XCTAssertEqual(titles.last, ShannonGeneratedStrings.desktopBodyQuit)
        withExtendedLifetime(body) {}
    }

    @MainActor
    func testTheCallIsTheFirstSectionOfTheSameMenu() {
        let menuBar = ShannonDesktopMenuBar()
        menuBar.makesStatusItem = false
        let body = ShannonDesktopBody()
        let app = ShannonDesktopBodyMenuSection(body: body, menuBar: menuBar)
        let call = StubSection()
        menuBar.register(app)
        menuBar.register(call)
        let items = menuBar.currentItems()
        XCTAssertEqual(items.first?.title, "通話")
        XCTAssertTrue(items[1].isSeparatorItem)
        XCTAssertEqual(menuBar.shownButton?.symbol, "waveform")
        withExtendedLifetime(body) {}
    }
}

final class ShannonDesktopBodyProbeTests: XCTestCase {
    /// A failed registration of the app's own figure is not "the server does not know the body": it is tried again soon.
    @MainActor
    func testTheServerIsJudgedOnlyAfterTheAppSaidItIsTheMac() async {
        let conversation = ShannonConversationModel(client: ShannonAPIClient(baseURL: URL(string: "https://example.test")!), usesDisplayCache: false)
        let body = ShannonDesktopBody()
        let fake = FakeDesktopBodyServer()
        body.conversation = conversation
        body.client = fake
        body.app = fake
        fake.appRegistrationFails = true
        let retry = await body.pollOnce()
        XCTAssertEqual(retry, 15)
        XCTAssertEqual(body.support, .unknown)
        XCTAssertEqual(fake.presenceReads, 0)
        fake.appRegistrationFails = false
        fake.heard = false
        let backOff = await body.pollOnce()
        XCTAssertEqual(backOff, 600)
        XCTAssertEqual(body.support, .unsupported)
        XCTAssertEqual(fake.presenceReads, 1)
        withExtendedLifetime(conversation) {}
    }
}

private final class FakeDesktopBodyServer: ShannonDesktopBodyServing, @unchecked Sendable {
    var appRegistrationFails = false
    var heard = true
    var presenceReads = 0

    func registerTouchBody(scopeKey: String, expressions: [String], gestures: [String]) async throws -> Int {
        if appRegistrationFails { throw URLError(.timedOut) }
        return 1
    }
    func bodyPresence(scopeKey: String, etag: String?, audience: ShannonBodyAudience?) async throws -> (ShannonDesktopBodyPresenceDTO, heardAsBody: Bool) {
        presenceReads += 1
        return (ShannonDesktopBodyPresenceDTO(etag: "3f9a1c0b7d2e4a68"), heard)
    }
    func registerDesktopBody(scopeKey: String, expressions: [String], gestures: [String], camera: Bool) async throws -> Int { 1 }
    func sendBodyEvents(scopeKey: String, events: [ShannonDesktopBodyEventDTO]) async throws {}
    func bodyInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO { ShannonInitiativeInboxDTO(unreadCount: 0, messages: []) }
    func reportReachOut(scopeKey: String, id: String, outcome: String) async throws {}
    func answerBodyLook(id: String, answer: ShannonBodyLookAnswerDTO) async throws -> ShannonBodyLookResponseDTO { throw URLError(.badServerResponse) }
    func bodyNudges(scopeKey: String) async throws -> ShannonBodyNudgesDTO { throw URLError(.badServerResponse) }
    func sendBodyTouches(scopeKey: String, events: [ShannonBodyTouchEventDTO]) async throws {}
    func askBodyReaction(_ request: ShannonBodyReactionRequestDTO) async throws -> ShannonBodyReactionAnswerDTO { throw URLError(.timedOut) }
}

@MainActor
private final class StubSection: ShannonDesktopMenuBarSection {
    var wantsMenuBarItem: Bool { true }
    var menuBarButton: ShannonDesktopMenuBarButton? { ShannonDesktopMenuBarButton(title: "0:12", symbol: "waveform", accessibilityLabel: "通話") }
    func menuBarItems() -> [NSMenuItem] { [NSMenuItem(title: "通話", action: nil, keyEquivalent: "")] }
}
#endif
