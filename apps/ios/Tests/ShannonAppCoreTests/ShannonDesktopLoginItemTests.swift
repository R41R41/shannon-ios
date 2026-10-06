#if os(macOS)
import Foundation
import XCTest
@testable import ShannonAppCore

/// Roadmap A18 S4: 「Mac にログインした時に開く」. On by default while a folder is chosen; the owner's choice holds.
@MainActor
final class ShannonDesktopLoginItemTests: XCTestCase {
    private final class FakeService: ShannonLoginItemService {
        var status: ShannonLoginItemStatus = .notRegistered
        var approvalRequired = false
        var fails = false
        var calls: [String] = []

        func register() throws {
            calls.append("register")
            if fails { throw CocoaError(.featureUnsupported) }
            status = approvalRequired ? .requiresApproval : .enabled
        }

        func unregister() throws {
            calls.append("unregister")
            if fails { throw CocoaError(.featureUnsupported) }
            status = .notRegistered
        }
    }

    private func make() throws -> (ShannonDesktopLoginItem, FakeService, UserDefaults) {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "shannon-login-\(UUID().uuidString)"))
        let service = FakeService()
        return (ShannonDesktopLoginItem(service: service, defaults: defaults), service, defaults)
    }

    func testTurningItOffInSystemSettingsIsTheOwnersChoiceAtTheNextLaunch() throws {
        let (item, service, defaults) = try make()
        item.apply(folderChosen: true)
        XCTAssertEqual(service.calls, ["register"])
        XCTAssertNil(item.ownerChoice)
        // The owner removes it in System Settings › General › Login Items; the app quits and opens again.
        service.status = .notRegistered
        let next = ShannonDesktopLoginItem(service: service, defaults: defaults)
        next.apply(folderChosen: true)
        XCTAssertEqual(service.calls, ["register"])
        XCTAssertEqual(next.ownerChoice, false)
        XCTAssertFalse(next.isOn)
        next.apply(folderChosen: true)
        XCTAssertEqual(service.calls, ["register"])
        // His switch in 設定 still turns it on again.
        next.set(true)
        XCTAssertEqual(service.calls, ["register", "register"])
        XCTAssertTrue(next.isOn)
    }

    func testTurningItOnInSystemSettingsIsTheOwnersChoiceTooAndSettingsSeesIt() throws {
        let (item, service, defaults) = try make()
        item.set(false)
        service.status = .enabled
        // 設定 opened: the state is read again and his choice taken.
        item.refresh()
        XCTAssertEqual(item.ownerChoice, true)
        XCTAssertTrue(item.isOn)
        let next = ShannonDesktopLoginItem(service: service, defaults: defaults)
        next.apply(folderChosen: false)
        XCTAssertEqual(service.calls, [])
        XCTAssertTrue(next.isOn)
    }

    func testAnAppMacOSCannotFindOrAFailedCallIsNotTakenForAChoice() throws {
        let (item, service, defaults) = try make()
        item.apply(folderChosen: true)
        service.status = .notFound
        ShannonDesktopLoginItem(service: service, defaults: defaults).apply(folderChosen: true)
        XCTAssertNil(item.ownerChoice)
        // A register that failed is not remembered as set: an item not there afterwards is not his choice.
        let (failing, failingService, failingDefaults) = try make()
        failingService.fails = true
        failing.apply(folderChosen: true)
        XCTAssertTrue(failing.failed)
        failingService.fails = false
        ShannonDesktopLoginItem(service: failingService, defaults: failingDefaults).apply(folderChosen: true)
        XCTAssertNil(failing.ownerChoice)
        XCTAssertEqual(failingService.calls, ["register", "register"])
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
