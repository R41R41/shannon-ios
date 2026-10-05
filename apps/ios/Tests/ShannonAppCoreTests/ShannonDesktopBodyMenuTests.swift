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

@MainActor
private final class StubSection: ShannonDesktopMenuBarSection {
    var wantsMenuBarItem: Bool { true }
    var menuBarButton: ShannonDesktopMenuBarButton? { ShannonDesktopMenuBarButton(title: "0:12", symbol: "waveform", accessibilityLabel: "通話") }
    func menuBarItems() -> [NSMenuItem] { [NSMenuItem(title: "通話", action: nil, keyEquivalent: "")] }
}
#endif
