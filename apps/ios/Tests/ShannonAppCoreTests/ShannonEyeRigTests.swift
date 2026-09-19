import XCTest
@testable import ShannonAppCore

final class ShannonEyeRigTests: XCTestCase {
    func testNeutralPoseKeepsTheApprovedKuriLikeGeometry() {
        let style = ShannonEyeRig.style(for: .neutral)

        XCTAssertEqual(style.gaze.yaw, 8, accuracy: 0.001)
        XCTAssertEqual(style.gaze.pitch, 5, accuracy: 0.001)
        XCTAssertEqual(style.gaze.roll, -4, accuracy: 0.001)
        XCTAssertEqual(style.split, 16.4, accuracy: 0.001)
        XCTAssertEqual(style.left.width, 0.23, accuracy: 0.001)
        XCTAssertEqual(style.left.height, 0.54, accuracy: 0.001)
        XCTAssertEqual(style.right.width, 0.22, accuracy: 0.001)
        XCTAssertEqual(style.right.height, 0.51, accuracy: 0.001)
    }

    func testEveryExpressionAndDialogueActivityProducesFiniteGeometry() {
        for expression in ShannonExpressionDTO.allCases {
            for activity in ShannonDialogueActivity.allCases {
                for elapsedTime in [0.0, 0.17, 0.9, 2.4, 7.7] {
                    let pose = ShannonEyeRig.pose(
                        for: expression,
                        activity: activity,
                        elapsedTime: elapsedTime,
                        isAnimated: true
                    )
                    let frame = ShannonEyeRig.frame(
                        pose: pose,
                        elapsedTime: elapsedTime,
                        isAnimated: true
                    )

                    XCTAssertEqual(frame.eyes.count, 2, "Missing eyes for \(expression) / \(activity)")
                    XCTAssertTrue(frame.eyes.allSatisfy { eye in
                        eye.position.x.isFinite
                            && eye.position.y.isFinite
                            && eye.depth.isFinite
                            && eye.depth > 0
                            && eye.configuration.width.isFinite
                            && eye.configuration.height.isFinite
                            && eye.configuration.width > 0
                            && eye.configuration.height > 0
                            && eye.configuration.open >= 0
                    }, "Invalid geometry for \(expression) / \(activity) at \(elapsedTime)")
                }
            }
        }
    }

    func testReducedMotionKeepsEveryActivityReadableButStill() {
        for activity in ShannonDialogueActivity.allCases {
            let first = ShannonEyeRig.pose(
                for: .curious,
                activity: activity,
                elapsedTime: 0,
                isAnimated: false
            )
            let later = ShannonEyeRig.pose(
                for: .curious,
                activity: activity,
                elapsedTime: 8,
                isAnimated: false
            )

            XCTAssertEqual(first.style, later.style, "Reduced-motion pose moved for \(activity)")
            XCTAssertEqual(first.decor.kind, later.decor.kind)
            XCTAssertEqual(first.decor.strength, later.decor.strength, accuracy: 0.001)
        }
    }

    func testTrackingLooksTowardTheTouchPoint() {
        let pose = ShannonEyeRig.pose(
            for: .neutral,
            activity: .idle,
            elapsedTime: 0,
            isAnimated: true,
            tracking: CGPoint(x: 0.5, y: -0.25)
        )

        XCTAssertEqual(pose.style.gaze.yaw, 15.5, accuracy: 0.001)
        XCTAssertEqual(pose.style.gaze.pitch, 6, accuracy: 0.001)
        XCTAssertEqual(pose.style.gaze.roll, -4, accuracy: 0.001)
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
        XCTAssertEqual(ShannonEyeRig.blinkLid(at: 1.9), 1, accuracy: 0.001)
        XCTAssertLessThan(ShannonEyeRig.blinkLid(at: 1.9756), 0.01)
        XCTAssertEqual(ShannonEyeRig.blinkLid(at: 2.08), 1, accuracy: 0.001)
        XCTAssertEqual(ShannonEyeRig.blinkScale(0), 0.06, accuracy: 0.001)

        let drowsy = ShannonEyeRig.blinkLid(at: 1.9 + 0.42 * 0.42, profile: .drowsy)
        XCTAssertLessThan(drowsy, 0.01)
    }

    func testWaterlightReactionKeepsTheExpressionAndAddsTheApprovedPulseAndBlush() {
        let origin = ShannonEyeRig.style(for: .curious)
        let base = ShannonEyeRig.style(for: .calm)

        XCTAssertEqual(
            ShannonEyeReactionTimeline.sample(origin: origin, base: base, elapsedTime: 0).style,
            base
        )
        let peak = ShannonEyeReactionTimeline.sample(origin: origin, base: base, elapsedTime: 0.45)
        XCTAssertEqual(peak.style.left.width, base.left.width * 1.07, accuracy: 0.001)
        XCTAssertEqual(peak.style.left.height, base.left.height * 0.90, accuracy: 0.001)
        XCTAssertEqual(peak.blushOpacity, 0.54, accuracy: 0.001)
        let finished = ShannonEyeReactionTimeline.sample(origin: origin, base: base, elapsedTime: 0.90)
        XCTAssertEqual(finished.style, base)
        XCTAssertEqual(finished.blushOpacity, 0, accuracy: 0.001)
    }

    func testWaterlightUsesTheApprovedDemoVisualConstants() {
        XCTAssertEqual(ShannonWaterlightVisualTokens.faceTop, 0x11243B)
        XCTAssertEqual(ShannonWaterlightVisualTokens.faceMiddle, 0x081522)
        XCTAssertEqual(ShannonWaterlightVisualTokens.faceBottom, 0x03070C)
        XCTAssertEqual(ShannonWaterlightVisualTokens.eyeTop, 0xC4FBFF)
        XCTAssertEqual(ShannonWaterlightVisualTokens.eyeMiddle, 0x76E7FF)
        XCTAssertEqual(ShannonWaterlightVisualTokens.eyeBottom, 0x6397FF)
        XCTAssertEqual(ShannonWaterlightVisualTokens.bodyRadiusRatio, 68.0 / 160.0, accuracy: 0.000_001)
        XCTAssertEqual(ShannonWaterlightVisualTokens.cornerRadiusRatio, 43.0 / 160.0, accuracy: 0.000_001)
        XCTAssertEqual(ShannonWaterlightVisualTokens.borderInsetRatio, 1.2 / 160.0, accuracy: 0.000_001)
        XCTAssertEqual(ShannonWaterlightVisualTokens.borderCornerRadiusRatio, 41.8 / 160.0, accuracy: 0.000_001)
        XCTAssertEqual(ShannonWaterlightVisualTokens.borderWidthRatio, 1.45 / 160.0, accuracy: 0.000_001)
        XCTAssertEqual(ShannonWaterlightVisualTokens.scanlineSpacingRatio, 4.0 / 160.0, accuracy: 0.000_001)
    }

    func testExpressionSelectsTheApprovedBlinkProfile() {
        XCTAssertEqual(
            ShannonEyeRig.pose(for: .neutral, activity: .idle, elapsedTime: 0, isAnimated: true).blinkProfile,
            .natural
        )
        XCTAssertEqual(
            ShannonEyeRig.pose(for: .excited, activity: .idle, elapsedTime: 0, isAnimated: true).blinkProfile,
            .sparse
        )
        XCTAssertEqual(
            ShannonEyeRig.pose(for: .sleepy, activity: .idle, elapsedTime: 0, isAnimated: true).blinkProfile,
            .drowsy
        )
    }

    func testWaterlightHeroUsesTheApprovedEyeScale() {
        XCTAssertEqual(ShannonEyeRig.heroEyeScale, 1.6, accuracy: 0.001)
    }
}
