#if os(macOS)
import Foundation
import XCTest
@testable import ShannonAppCore

/// Roadmap A18 S4: 「Mac にログインした時に開く」. On by default while a folder is chosen; the owner's choice holds.
@MainActor
final class ShannonDesktopLoginItemTests: XCTestCase {
    private final class FakeService: ShannonLoginItemService {
        var isEnabled = false
        var needsApproval = false
        var approvalRequired = false
        var fails = false
        var calls: [String] = []

        func register() throws {
            calls.append("register")
            if fails { throw CocoaError(.featureUnsupported) }
            if approvalRequired { needsApproval = true } else { isEnabled = true }
        }

        func unregister() throws {
            calls.append("unregister")
            if fails { throw CocoaError(.featureUnsupported) }
            isEnabled = false
            needsApproval = false
        }
    }

    private func make() throws -> (ShannonDesktopLoginItem, FakeService, UserDefaults) {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-login-\(UUID().uuidString)"))
        let service = FakeService()
        return (ShannonDesktopLoginItem(service: service, defaults: defaults), service, defaults)
    }

    func testItFollowsTheFolderUntilTheOwnerChooses() throws {
        let (item, service, _) = try make()
        item.apply(folderChosen: false)
        XCTAssertEqual(service.calls, [])
        XCTAssertFalse(item.isOn)
        item.apply(folderChosen: true)
        XCTAssertEqual(service.calls, ["register"])
        XCTAssertTrue(item.isOn)
        item.apply(folderChosen: true)
        XCTAssertEqual(service.calls, ["register"])
        item.apply(folderChosen: false)
        XCTAssertEqual(service.calls, ["register", "unregister"])
        XCTAssertFalse(item.isOn)

        // His choice holds whatever the folder does.
        item.set(false)
        item.apply(folderChosen: true)
        XCTAssertFalse(item.isOn)
        XCTAssertEqual(item.ownerChoice, false)
        item.set(true)
        item.apply(folderChosen: false)
        XCTAssertTrue(item.isOn)
    }

    func testItSaysWhenMacOSWaitsForApprovalOrRefuses() throws {
        let (item, service, _) = try make()
        service.approvalRequired = true
        item.apply(folderChosen: true)
        XCTAssertTrue(item.needsApproval)
        XCTAssertFalse(item.isOn)
        // Waiting for approval counts as registered: it is not asked again.
        item.apply(folderChosen: true)
        XCTAssertEqual(service.calls, ["register"])
        service.fails = true
        item.set(false)
        XCTAssertTrue(item.failed)
    }
}
#endif
