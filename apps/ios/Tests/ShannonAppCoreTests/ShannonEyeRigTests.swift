import XCTest
@testable import ShannonAppCore

final class ShannonEyeRigTests: XCTestCase {
    func testNeutralPoseKeepsTheMeasuredWaterlightGeometry() {
        let style = ShannonEyeRig.style(for: .neutral)

        XCTAssertEqual(style.gaze.yaw, 28.49, accuracy: 0.001)
        XCTAssertEqual(style.gaze.pitch, 28.62, accuracy: 0.001)
        XCTAssertEqual(style.gaze.roll, -13, accuracy: 0.001)
        XCTAssertEqual(style.split, 15.46, accuracy: 0.001)
        XCTAssertEqual(style.left.width, 0.186, accuracy: 0.001)
        XCTAssertEqual(style.left.height, 0.412, accuracy: 0.001)
        XCTAssertEqual(style.left, style.right)
    }

    func testEveryShannonExpressionProducesTwoVisibleFiniteEyes() {
        for expression in ShannonExpressionDTO.allCases {
            let style = ShannonEyeRig.style(for: expression)
            let frame = ShannonEyeRig.frame(style: style, elapsedTime: 0, isAnimated: false)

            XCTAssertEqual(frame.eyes.count, 2, "Missing eyes for \(expression)")
            XCTAssertTrue(frame.eyes.allSatisfy { eye in
                eye.position.x.isFinite
                    && eye.position.y.isFinite
                    && eye.depth.isFinite
                    && eye.depth > 0
                    && eye.configuration.width > 0
                    && eye.configuration.height > 0
            }, "Invalid projection for \(expression)")
        }
    }

    func testBlinkClosesAndReopensWithoutCollapsingToZero() {
        XCTAssertEqual(ShannonEyeRig.blinkLid(at: 1.4), 1, accuracy: 0.001)
        XCTAssertLessThan(ShannonEyeRig.blinkLid(at: 1.481), 0.01)
        XCTAssertEqual(ShannonEyeRig.blinkLid(at: 1.58), 1, accuracy: 0.001)
        XCTAssertEqual(ShannonEyeRig.blinkScale(0), 0.06, accuracy: 0.001)
    }

    func testWaterlightReactionMovesFromSurpriseToBashfulAndBackToBase() {
        let origin = ShannonEyeRig.style(for: .curious)
        let base = ShannonEyeRig.style(for: .calm)

        XCTAssertEqual(
            ShannonEyeReactionTimeline.sample(origin: origin, base: base, elapsedTime: 0).style,
            origin
        )
        XCTAssertEqual(
            ShannonEyeReactionTimeline.sample(origin: origin, base: base, elapsedTime: 0.16).style,
            ShannonEyeRig.style(for: .surprised)
        )
        let bashful = ShannonEyeReactionTimeline.sample(origin: origin, base: base, elapsedTime: 0.42)
        XCTAssertEqual(bashful.style, ShannonEyeRig.style(for: .bashful))
        XCTAssertEqual(bashful.blushOpacity, 1, accuracy: 0.001)
        let finished = ShannonEyeReactionTimeline.sample(origin: origin, base: base, elapsedTime: 1.50)
        XCTAssertEqual(finished.style, base)
        XCTAssertEqual(finished.blushOpacity, 0, accuracy: 0.001)
    }

    func testWaterlightHeroUsesTheApprovedEyeScale() {
        XCTAssertEqual(ShannonEyeRig.heroEyeScale, 1.6, accuracy: 0.001)
    }
}
