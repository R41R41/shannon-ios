import Foundation
import XCTest
@testable import ShannonAppCore

final class ShannonColorSystemTests: XCTestCase {
    func testSyzygySemanticTokensRemainStable() {
        XCTAssertEqual(ShannonColorTokens.Intelligence.sky, 0x78D9FF)
        XCTAssertEqual(ShannonColorTokens.Intelligence.core, 0x5865F2)
        XCTAssertEqual(ShannonColorTokens.Intelligence.depth, 0x3039A8)
        XCTAssertEqual(ShannonColorTokens.Intelligence.ink, 0x090A0F)
        XCTAssertEqual(ShannonColorTokens.Light.action, 0x0088FF)
        XCTAssertEqual(ShannonColorTokens.Light.canvas, 0xFFFFFF)
        XCTAssertEqual(ShannonColorTokens.Light.subtleSurface, 0xF2F2F7)
        XCTAssertEqual(ShannonColorTokens.Light.creation, 0xFFCC00)
        XCTAssertEqual(ShannonColorTokens.Light.attention, 0xFF8D28)
        XCTAssertEqual(ShannonColorTokens.Light.success, 0x34C759)
        XCTAssertEqual(ShannonColorTokens.Light.danger, 0xFF383C)
        XCTAssertEqual(ShannonColorTokens.Light.characterBlush, 0xF2A6B8)
        XCTAssertEqual(ShannonColorTokens.Dark.action, 0x0091FF)
        XCTAssertEqual(ShannonColorTokens.Dark.canvas, 0x000000)
        XCTAssertEqual(ShannonColorTokens.Dark.subtleSurface, 0x1C1C1E)
        XCTAssertEqual(ShannonColorTokens.Dark.elevatedSurface, 0x2C2C2E)
        XCTAssertEqual(ShannonColorTokens.Dark.creation, 0xFFD600)
        XCTAssertEqual(ShannonColorTokens.Dark.attention, 0xFF9230)
        XCTAssertEqual(ShannonColorTokens.Dark.success, 0x30D158)
        XCTAssertEqual(ShannonColorTokens.Dark.danger, 0xFF4245)
        XCTAssertEqual(ShannonColorTokens.Dark.characterBlush, 0xF5A3B6)
    }

    func testActionControlsAndReadingTextMeetTheirContrastThresholds() {
        XCTAssertGreaterThanOrEqual(
            contrastRatio(ShannonColorTokens.Light.action, ShannonColorTokens.Light.onAction),
            3.0
        )
        XCTAssertGreaterThanOrEqual(
            contrastRatio(ShannonColorTokens.Dark.action, ShannonColorTokens.Dark.onAction),
            3.0
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

    func testIntelligenceAndActionRemainDistinctMeanings() {
        XCTAssertNotEqual(ShannonColorTokens.Light.brandPresence, ShannonColorTokens.Light.action)
        XCTAssertEqual(ShannonColorTokens.Light.brandPresence, ShannonColorTokens.Dark.brandPresence)
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
