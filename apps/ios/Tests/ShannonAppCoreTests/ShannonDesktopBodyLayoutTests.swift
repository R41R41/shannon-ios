#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import ShannonAppCore

/// Her desktop window's column: the stage stays where the window controller's mask and grip zones expect it
/// (`ShannonDesktopBodyGeometry.stageRect`), whatever the length of her line.
@MainActor
final class ShannonDesktopBodyLayoutTests: XCTestCase {
    private final class Frames {
        var words = CGRect.null
        var stage = CGRect.null
    }

    private func layOut(wordsHeight: CGFloat, window size: CGSize = CGSize(width: 400, height: 680)) -> Frames {
        let frames = Frames()
        let column = ShannonDesktopBodyColumn(stageHeight: 520) {
            Color.clear
                .frame(width: 300, height: wordsHeight)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.words = $0 }
        } stage: {
            Color.clear
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.stage = $0 }
        }
        let hosting = NSHostingView(rootView: column)
        hosting.sizingOptions = []
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        hosting.frame = CGRect(origin: .zero, size: size)
        for _ in 0..<3 {
            hosting.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        window.contentView = nil
        return frames
    }

    func testALineTallerThanTheRoomAboveHerSpillsUpwardAndTheStageStays() {
        let short = layOut(wordsHeight: 40)
        let long = layOut(wordsHeight: 900)
        XCTAssertEqual(short.stage, CGRect(x: 0, y: 160, width: 400, height: 520))
        XCTAssertEqual(long.stage, short.stage)
        XCTAssertEqual(long.words.maxY, 160, accuracy: 0.5)
        XCTAssertLessThan(long.words.minY, 0)
    }

    func testAWindowLowerThanTheStageGivesItAllToTheStage() {
        let low = layOut(wordsHeight: 40, window: CGSize(width: 400, height: 400))
        XCTAssertEqual(low.stage, CGRect(x: 0, y: 0, width: 400, height: 400))
    }
}
#endif
