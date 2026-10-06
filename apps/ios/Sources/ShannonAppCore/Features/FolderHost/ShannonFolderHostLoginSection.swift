#if os(macOS)
import Observation
import ServiceManagement
import SwiftUI

/// The app as a login item (`SMAppService.mainApp`). A protocol so the default and the owner's choice are tested without
/// registering anything.
@MainActor
public protocol ShannonLoginItemService: AnyObject {
    var isEnabled: Bool { get }
    var needsApproval: Bool { get }
    func register() throws
    func unregister() throws
}

@MainActor
public final class ShannonMainAppLoginItem: ShannonLoginItemService {
    public init() {}
    public var isEnabled: Bool { SMAppService.mainApp.status == .enabled }
    public var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }
    public func register() throws { try SMAppService.mainApp.register() }
    public func unregister() throws { try SMAppService.mainApp.unregister() }
}

/// 「Mac にログインした時に開く」 (roadmap A18 S4; Windows 「PC の起動時に開く」). Default: on while a folder is chosen,
/// off otherwise. Her folder is hosted only while the app runs, and choosing a folder is the owner saying he wants it hosted
/// (owner decision 2026-10-06: while a folder is chosen the app stays and keeps hosting), so after a restart she can still
/// use it; without a folder the app is not started behind his back. Once the owner sets the switch, his choice holds.
@MainActor
@Observable
public final class ShannonDesktopLoginItem {
    public static let shared = ShannonDesktopLoginItem()
    public static let choiceKey = "ShannonOpenAtLoginChoice"

    public private(set) var isOn = false
    public private(set) var needsApproval = false
    public private(set) var failed = false

    @ObservationIgnored private let service: any ShannonLoginItemService
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var folderChosen = false

    public init(service: (any ShannonLoginItemService)? = nil, defaults: UserDefaults = .standard) {
        self.service = service ?? ShannonMainAppLoginItem()
        self.defaults = defaults
    }

    /// The owner's own choice, or nil while the default (the folder) decides.
    public var ownerChoice: Bool? { defaults.object(forKey: Self.choiceKey) as? Bool }

    /// Follows the folder: called whenever a folder is chosen or let go.
    public func apply(folderChosen: Bool) {
        self.folderChosen = folderChosen
        sync(ownerChoice ?? folderChosen)
    }

    /// The owner's switch in 設定 › 専用フォルダ.
    public func set(_ on: Bool) {
        defaults.set(on, forKey: Self.choiceKey)
        sync(on)
    }

    /// Reads the system's state again (it can be changed in System Settings).
    public func refresh() {
        update(isOn: service.isEnabled, needsApproval: service.needsApproval, failed: failed)
    }

    private func sync(_ wanted: Bool) {
        var failed = false
        if wanted != (service.isEnabled || service.needsApproval) {
            do {
                if wanted { try service.register() } else { try service.unregister() }
            } catch {
                failed = true
            }
        }
        update(isOn: service.isEnabled, needsApproval: service.needsApproval, failed: failed)
    }

    /// Observed values are written only when they change (no redraw of 設定 for nothing).
    private func update(isOn: Bool, needsApproval: Bool, failed: Bool) {
        if self.isOn != isOn { self.isOn = isOn }
        if self.needsApproval != needsApproval { self.needsApproval = needsApproval }
        if self.failed != failed { self.failed = failed }
    }
}

/// 設定 › 専用フォルダ, below the folder: opening at login, and the steps to retire the old Mac app (Electron, A18 S4).
public struct ShannonFolderHostLoginSection: View {
    @Bindable private var loginItem: ShannonDesktopLoginItem

    public init(loginItem: ShannonDesktopLoginItem = .shared) {
        self.loginItem = loginItem
    }

    public var body: some View {
        Section {
            Toggle(ShannonGeneratedStrings.folderHostOpenAtLogin, isOn: Binding(
                get: { loginItem.isOn || loginItem.needsApproval },
                set: { loginItem.set($0) }
            ))
            .accessibilityIdentifier("settings-folder-open-at-login")
            if loginItem.needsApproval {
                Text(ShannonGeneratedStrings.folderHostOpenAtLoginApproval)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
            }
            if loginItem.failed {
                Text(ShannonGeneratedStrings.folderHostOpenAtLoginFailed)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(Color.shannonDanger)
            }
        } footer: {
            Text(ShannonGeneratedStrings.folderHostOpenAtLoginDefault)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
        }
        Section(ShannonGeneratedStrings.folderHostRetireTitle) {
            Text(ShannonGeneratedStrings.folderHostRetireSteps)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .onAppear { loginItem.refresh() }
    }
}
#endif
