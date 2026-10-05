import SwiftUI
import XCTest
@testable import ShannonAppCore

final class ShannonDesktopDesignTests: XCTestCase {
    /// Shared views name a text style once: the phone gets exactly its Dynamic Type font, the Mac the
    /// same step of the desktop scale, so headings never fall below the body text of 15 there.
    func testSharedTextStylesFollowThePlatformScale() {
        for style in ShannonDesktopTextStyle.allCases {
#if os(macOS)
            XCTAssertEqual(Font.shannon(style), Font.shannonDesktop(style), "\(style)")
#else
            XCTAssertEqual(Font.shannon(style), style.dynamicTypeFont, "\(style)")
#endif
        }
        XCTAssertEqual(ShannonDesktopTextStyle.body.token.size, 15)
        let headings: [ShannonDesktopTextStyle] = [.largeTitle, .title, .title2, .title3, .headline]
        for heading in headings {
            XCTAssertGreaterThanOrEqual(heading.token.size, ShannonDesktopTextStyle.body.token.size, "\(heading)")
        }
        XCTAssertEqual(ShannonDesktopTextStyle.headline.dynamicTypeFont, Font.headline)
    }
}
