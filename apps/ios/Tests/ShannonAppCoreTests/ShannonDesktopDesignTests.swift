import SwiftUI
import XCTest
@testable import ShannonAppCore

final class ShannonDesktopDesignTests: XCTestCase {
    /// Shared views name a text style once: the phone gets exactly its Dynamic Type font, the Mac the
    /// same step of the desktop scale, so headings never fall below the body text of 15 there.
    func testSharedTextStylesFollowThePlatformScale() {
#if os(macOS)
        for style in ShannonDesktopTextStyle.allCases {
            XCTAssertEqual(Font.shannon(style), Font.shannonDesktop(style), "\(style)")
        }
#else
        let phone: [(ShannonDesktopTextStyle, Font, Font.TextStyle)] = [
            (.largeTitle, .largeTitle, .largeTitle), (.title, .title, .title), (.title2, .title2, .title2),
            (.title3, .title3, .title3), (.headline, .headline, .headline), (.body, .body, .body),
            (.callout, .callout, .callout), (.subheadline, .subheadline, .subheadline), (.footnote, .footnote, .footnote),
            (.caption, .caption, .caption), (.caption2, .caption2, .caption2),
        ]
        XCTAssertEqual(phone.count, ShannonDesktopTextStyle.allCases.count)
        for (style, font, textStyle) in phone {
            XCTAssertEqual(Font.shannon(style), font, "\(style)")
            XCTAssertEqual(Font.shannon(style, design: .monospaced), Font.system(textStyle, design: .monospaced), "\(style)")
        }
#endif
        XCTAssertEqual(ShannonDesktopTextStyle.body.token.size, 15)
        let headings: [ShannonDesktopTextStyle] = [.largeTitle, .title, .title2, .title3, .headline]
        for heading in headings {
            XCTAssertGreaterThanOrEqual(heading.token.size, ShannonDesktopTextStyle.body.token.size, "\(heading)")
        }
    }
}
