import Foundation
import XCTest
@testable import ShannonAppCore

final class ShannonColorSystemTests: XCTestCase {
    func testClearSignalSemanticTokensRemainStable() {
        XCTAssertEqual(ShannonColorTokens.Light.brandPresence, 0x0E92EF)
        XCTAssertEqual(ShannonColorTokens.Light.actionPrimary, 0x006AA6)
        XCTAssertEqual(ShannonColorTokens.Light.canvas, 0xF8FBFD)
        XCTAssertEqual(ShannonColorTokens.Light.userMessage, 0xE7F4FC)
        XCTAssertEqual(ShannonColorTokens.Dark.brandPresence, 0x46B9FF)
        XCTAssertEqual(ShannonColorTokens.Dark.actionPrimary, 0x56C0FF)
        XCTAssertEqual(ShannonColorTokens.Dark.canvas, 0x08131B)
        XCTAssertEqual(ShannonColorTokens.Dark.userMessage, 0x153246)
    }

    func testActionAndReadingPairsMeetNormalTextContrast() {
        XCTAssertGreaterThanOrEqual(
            contrastRatio(ShannonColorTokens.Light.actionPrimary, 0xFFFFFF),
            4.5
        )
        XCTAssertGreaterThanOrEqual(
            contrastRatio(ShannonColorTokens.Dark.actionPrimary, ShannonColorTokens.Dark.onActionPrimary),
            4.5
        )
        XCTAssertGreaterThanOrEqual(
            contrastRatio(ShannonColorTokens.Light.textPrimary, ShannonColorTokens.Light.canvas),
            4.5
        )
        XCTAssertGreaterThanOrEqual(
            contrastRatio(ShannonColorTokens.Dark.textPrimary, ShannonColorTokens.Dark.canvas),
            4.5
        )
    }

    func testPresenceBlueIsNotMistakenForLightModeActionFill() {
        XCTAssertLessThan(
            contrastRatio(ShannonColorTokens.Light.brandPresence, 0xFFFFFF),
            4.5
        )
    }

    private func contrastRatio(_ first: UInt, _ second: UInt) -> Double {
        let lighter = max(relativeLuminance(first), relativeLuminance(second))
        let darker = min(relativeLuminance(first), relativeLuminance(second))
        return (lighter + 0.05) / (darker + 0.05)
    }

    private func relativeLuminance(_ value: UInt) -> Double {
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    private func linear(_ component: Double) -> Double {
        component <= 0.04045
            ? component / 12.92
            : pow((component + 0.055) / 1.055, 2.4)
    }
}
