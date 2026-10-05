#if os(macOS)
import XCTest
@testable import ShannonAppCore

/// Her figure beside Mac Talk moves the way the fingers go, whatever the scroll direction setting (A15).
@MainActor
final class ShannonFigureScrollTests: XCTestCase {
    private let bounds = CGSize(width: 400, height: 600)

    func testNaturalAndClassicScrollingMoveHerTheSameWay() {
        // Fingers move down and right. With natural scrolling AppKit reports that as is (inverted from the
        // device); with classic scrolling the same finger movement arrives with the opposite sign.
        let natural = ShannonLive2DContainerView.scrolled(
            ShannonLive2DLayout(), deltaX: 10, deltaY: 20, precise: true, inverted: true, scales: false, in: bounds)
        let classic = ShannonLive2DContainerView.scrolled(
            ShannonLive2DLayout(), deltaX: -10, deltaY: -20, precise: true, inverted: false, scales: false, in: bounds)
        XCTAssertEqual(natural, classic)
        XCTAssertGreaterThan(natural.offsetX, 0)
        XCTAssertGreaterThan(natural.offsetY, 0)
    }

    func testCommandScrollUpMakesHerLarger() {
        let up = ShannonLive2DContainerView.scrolled(
            ShannonLive2DLayout(), deltaX: 0, deltaY: -20, precise: true, inverted: true, scales: true, in: bounds)
        XCTAssertGreaterThan(up.scale, ShannonLive2DLayout().scale)
        XCTAssertEqual(up.offsetX, 0)
    }
}
#endif
