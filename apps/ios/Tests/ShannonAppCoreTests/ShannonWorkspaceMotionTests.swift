import XCTest
@testable import ShannonAppCore

final class ShannonWorkspaceMotionTests: XCTestCase {
    func testPageProgressTracksFingerContinuously() {
        XCTAssertEqual(
            ShannonWorkspaceMotionPolicy.pageProgress(
                from: 0,
                translation: -195,
                width: 390,
                pageCount: 3
            ),
            0.5,
            accuracy: 0.001
        )
    }

    func testProjectedSwipeSettlesOnOnePageOnly() {
        XCTAssertEqual(
            ShannonWorkspaceMotionPolicy.targetPage(
                from: 0,
                predictedTranslation: -240,
                width: 390,
                pageCount: 3
            ),
            1
        )
        XCTAssertEqual(
            ShannonWorkspaceMotionPolicy.targetPage(
                from: 0,
                predictedTranslation: -900,
                width: 390,
                pageCount: 3
            ),
            1
        )
        XCTAssertEqual(
            ShannonWorkspaceMotionPolicy.targetPage(
                from: 1,
                predictedTranslation: -900,
                width: 390,
                pageCount: 3
            ),
            2
        )
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

    func testProgressIsClampedAtWorkspaceEdges() {
        XCTAssertEqual(
            ShannonWorkspaceMotionPolicy.pageProgress(
                from: 0,
                translation: 500,
                width: 390,
                pageCount: 3
            ),
            0
        )
        XCTAssertEqual(
            ShannonWorkspaceMotionPolicy.pageProgress(
                from: 2,
                translation: -500,
                width: 390,
                pageCount: 3
            ),
            2
        )
    }
}
