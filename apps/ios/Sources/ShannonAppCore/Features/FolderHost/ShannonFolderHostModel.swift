#if os(macOS)
import AppKit
import Foundation
import Observation

/// Her folder on this Mac (roadmap A18 S2, owner decisions of 2026-10-06): the folder the owner chose, kept as a bookmark;
/// the owner's pause on this Mac (`localStop`); a self-check; stopping; and the local log. While a folder is chosen the app
/// keeps claiming in the background, with or without a window, and stays in the menu bar.
@MainActor
@Observable
public final class ShannonFolderHostModel {
    public static let shared = ShannonFolderHostModel()

    public enum State: Equatable, Sendable { case unset, running, paused, failed }

    public struct CheckStep: Equatable, Sendable, Identifiable {
        public let label: String
        public let ok: Bool
        public let detail: String?
        public var id: String { label }
    }

    public struct Check: Equatable, Sendable {
        public let ok: Bool
        public let steps: [CheckStep]
    }

    public static let pausedKey = "ShannonFolderHostPaused"

    public private(set) var folder: URL?
    public private(set) var isChosen = false
    public private(set) var isPaused: Bool
    public private(set) var link: ShannonFolderHostLink = .waiting
    public private(set) var check: Check?
    public private(set) var recent: [ShannonFolderHostLogEntry] = []
    public private(set) var problem: String?
    public private(set) var deviceID: String?

    @ObservationIgnored private let bookmarks: ShannonFolderBookmarkStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let log: ShannonFolderHostActivityLog
    @ObservationIgnored private let worker = ShannonFolderHostWorker()
    @ObservationIgnored private var runner: ShannonFolderHostRunner?
    @ObservationIgnored private var client: ShannonFolderHostClaimClient?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var lastClaimAt: Date?
    @ObservationIgnored private var menuSection: ShannonFolderHostMenuSection?

    public init(bookmarks: ShannonFolderBookmarkStore = ShannonFolderBookmarkStore(), defaults: UserDefaults = .standard,
                log: ShannonFolderHostActivityLog = ShannonFolderHostActivityLog()) {
        self.bookmarks = bookmarks
        self.defaults = defaults
        self.log = log
        isPaused = defaults.bool(forKey: Self.pausedKey)
    }

    public var state: State {
        guard isChosen else { return .unset }
        guard folder != nil else { return .failed }
        return isPaused ? .paused : .running
    }

    /// Called once at launch: resolves the remembered folder and starts claiming while one is chosen.
    public func start(api: ShannonAPIClient) {
        guard client == nil else { return }
        let client = ShannonFolderHostClaimClient(api: api)
        self.client = client
        runner = ShannonFolderHostRunner(transport: client, worker: worker)
        deviceID = client.deviceID
        recent = log.recent()
        let section = ShannonFolderHostMenuSection(model: self)
        menuSection = section
        ShannonDesktopMenuBar.shared.register(section)
        restore()
    }

    // MARK: The owner's actions

    /// The open panel; the chosen folder is taken if it is empty or already hers (`ShannonFolderHostAdoption`).
    public func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = ShannonGeneratedStrings.folderHostChoosePrompt
        panel.message = ShannonGeneratedStrings.folderHostChooseMessage
        guard panel.runModal() == .OK, let url = panel.url else { return }
        choose(url)
    }

    public func choose(_ url: URL) {
        do {
            try ShannonFolderHostAdoption.adopt(url)
            try bookmarks.save(url)
        } catch let problem as ShannonFolderHostAdoption.Problem {
            self.problem = switch problem {
            case .notAFolder: ShannonGeneratedStrings.folderHostNotAFolder
            case .notEmpty: ShannonGeneratedStrings.folderHostNotEmpty
            case .cannotMark: ShannonGeneratedStrings.folderHostCannotMark
            }
            return
        } catch {
            problem = ShannonGeneratedStrings.folderHostBookmarkFailed
            return
        }
        check = nil
        restore()
    }

    public func setPaused(_ paused: Bool) {
        isPaused = paused
        defaults.set(paused, forKey: Self.pausedKey)
        // A held claim is dropped at once, so the server hears the switch with the next claim.
        restartLoop()
    }

    /// Forgets the folder. The folder and its files stay as they are.
    public func stopUsing() {
        loop?.cancel()
        loop = nil
        if let folder { bookmarks.stopAccessing(folder) }
        bookmarks.forget()
        folder = nil
        isChosen = false
        check = nil
        problem = nil
        link = .waiting
        Task { await worker.setFolder(nil) }
        ShannonDesktopMenuBar.shared.refresh()
    }

    public func openFolder() {
        if let folder { NSWorkspace.shared.open(folder) }
    }

    /// 動作を確かめる: the folder opens, its top can be listed, this Mac is registered, and a claim reached the server.
    public func runSelfCheck() async {
        var steps: [CheckStep] = []
        let opened = folder.flatMap { try? ShannonFolderHostRoot(folder: $0) }
        steps.append(.init(label: ShannonGeneratedStrings.folderHostCheckFolder, ok: opened != nil, detail: opened == nil ? ShannonGeneratedStrings.folderHostBookmarkFailed : nil))
        let listed = opened.flatMap { try? ShannonFolderHostOperations.list($0, relativePath: "", recursive: false, limit: 500) }
        steps.append(.init(label: ShannonGeneratedStrings.folderHostCheckList, ok: listed != nil, detail: nil))
        var binding: ShannonFolderHostBinding?
        var reached = false
        if let client {
            do {
                binding = try await client.binding()
                reached = true
            } catch {
                reached = false
            }
        }
        steps.append(.init(label: ShannonGeneratedStrings.folderHostCheckRegistered, ok: binding?.host != nil,
                           detail: binding?.host == nil ? deviceID.map { ShannonGeneratedStrings.folderHostNotRegistered(deviceId: $0) } : binding?.host))
        let recentClaim = lastClaimAt.map { Date().timeIntervalSince($0) < 60 } ?? false
        steps.append(.init(label: ShannonGeneratedStrings.folderHostCheckServer, ok: reached && (recentClaim || isPaused), detail: reached ? nil : ShannonGeneratedStrings.folderHostOffline))
        check = Check(ok: steps.allSatisfy(\.ok), steps: steps)
        if binding?.host != nil, case .notRegistered = link { await runner?.reset(); restartLoop() }
    }

    // MARK: The loop

    /// Every access `restore` opens is closed once: the folder open now is closed before the bookmark is opened again, also
    /// when the owner chose the same folder again.
    private func restore() {
        if let folder { bookmarks.stopAccessing(folder) }
        folder = nil
        isChosen = bookmarks.isChosen
        switch bookmarks.restore() {
        case .none:
            folder = nil
        case .folder(let url):
            folder = url
            problem = nil
        case .failed:
            folder = nil
            problem = ShannonGeneratedStrings.folderHostBookmarkFailed
        }
        let chosen = folder
        Task { await worker.setFolder(chosen) }
        ShannonDesktopMenuBar.shared.refresh()
        restartLoop()
    }

    private func restartLoop() {
        loop?.cancel()
        loop = nil
        // A chosen folder that cannot be opened still claims, so a step is refused with `folder_not_configured`.
        guard isChosen, let runner else { return }
        loop = Task { [weak self] in
            let activity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiatedAllowingIdleSystemSleep], reason: "シャノン専用フォルダの受け持ち")
            defer { ProcessInfo.processInfo.endActivity(activity) }
            while !Task.isCancelled {
                let turn = await runner.turn { @MainActor [weak self] in self?.isPaused ?? true }
                guard !Task.isCancelled, let self else { return }
                self.apply(turn)
                if turn.delay > 0 { try? await Task.sleep(for: .seconds(turn.delay)) }
            }
        }
    }

    /// Observed values are written only when they change: an unchanged poll must not invalidate 設定 (every write of an
    /// observed property re-renders its views, and the Mac app is guarding against AppKit update-constraint loops).
    func apply(_ turn: ShannonFolderHostRunner.Turn) {
        if turn.link != .waiting, turn.link != link { link = turn.link }
        if case .connected = turn.link { lastClaimAt = Date() }
        let device = client?.deviceID
        if device != deviceID { deviceID = device }
        if let entry = turn.entry {
            log.append(entry)
            recent.insert(entry, at: 0)
            if recent.count > 50 { recent.removeLast(recent.count - 50) }
        }
    }
}
#endif
