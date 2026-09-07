import CoreGraphics
import XCTest
@testable import ShannonAppCore

final class ShannonWorkspaceMotionTests: XCTestCase {
    func testDrawerStartsFromTheLeftHalfOnTalk() {
        XCTAssertTrue(ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
            isTalkSelected: true,
            composerIsFocused: false,
            currentProgress: 0,
            viewWidth: 390,
            startX: 20,
            translation: CGSize(width: 24, height: 2)
        ))
        XCTAssertTrue(ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
            isTalkSelected: true,
            composerIsFocused: false,
            currentProgress: 0,
            viewWidth: 390,
            startX: 180,
            translation: CGSize(width: 24, height: 2)
        ))
        XCTAssertFalse(ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
            isTalkSelected: true,
            composerIsFocused: false,
            currentProgress: 0,
            viewWidth: 390,
            startX: 220,
            translation: CGSize(width: 24, height: 2)
        ))
        XCTAssertFalse(ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
            isTalkSelected: false,
            composerIsFocused: false,
            currentProgress: 0,
            viewWidth: 390,
            startX: 20,
            translation: CGSize(width: 24, height: 2)
        ))
    }

    func testDrawerGestureDoesNotCompeteWithTypingOrVerticalScroll() {
        XCTAssertFalse(ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
            isTalkSelected: true,
            composerIsFocused: true,
            currentProgress: 0,
            viewWidth: 390,
            startX: 10,
            translation: CGSize(width: 30, height: 1)
        ))
        XCTAssertFalse(ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
            isTalkSelected: true,
            composerIsFocused: false,
            currentProgress: 0,
            viewWidth: 390,
            startX: 10,
            translation: CGSize(width: 4, height: 30)
        ))
    }

    func testOpenDrawerCanBeClosedFromAnywhere() {
        XCTAssertTrue(ShannonWorkspaceMotionPolicy.canBeginDrawerDrag(
            isTalkSelected: true,
            composerIsFocused: false,
            currentProgress: 1,
            viewWidth: 390,
            startX: 220,
            translation: CGSize(width: -24, height: 2)
        ))
    }

    func testDrawerFollowsFingerAndUsesReleaseThreshold() {
        XCTAssertEqual(
            ShannonWorkspaceMotionPolicy.drawerProgress(
                from: 0,
                translation: 156,
                drawerWidth: 312
            ),
            0.5,
            accuracy: 0.001
        )
        XCTAssertTrue(
            ShannonWorkspaceMotionPolicy.shouldOpenDrawer(
                from: 0,
                predictedTranslation: 180,
                drawerWidth: 312
            )
        )
        XCTAssertFalse(
            ShannonWorkspaceMotionPolicy.shouldOpenDrawer(
                from: 1,
                predictedTranslation: -220,
                drawerWidth: 312
            )
        )
    }

}
