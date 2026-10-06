#if os(macOS)
import Foundation

/// How a folder is remembered across launches: an app-scoped security-scoped bookmark
/// (`com.apple.security.files.bookmarks.app-scope`). A protocol, so the stale and failing cases are tested without a sandbox.
public protocol ShannonFolderBookmarking: Sendable {
    func bookmark(for folder: URL) throws -> Data
    func resolve(_ data: Data) throws -> (folder: URL, isStale: Bool)
    func startAccessing(_ folder: URL) -> Bool
    func stopAccessing(_ folder: URL)
}

public struct ShannonSecurityScopedBookmarks: ShannonFolderBookmarking {
    public init() {}

    public func bookmark(for folder: URL) throws -> Data {
        try folder.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    public func resolve(_ data: Data) throws -> (folder: URL, isStale: Bool) {
        var stale = false
        let folder = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        return (folder, stale)
    }

    public func startAccessing(_ folder: URL) -> Bool { folder.startAccessingSecurityScopedResource() }
    public func stopAccessing(_ folder: URL) { folder.stopAccessingSecurityScopedResource() }
}

/// The chosen folder in `UserDefaults`, resolved at launch. A stale bookmark is made again while the folder is open; a
/// bookmark that cannot be resolved or opened leaves the folder chosen but unusable (`folder_not_configured`), so the
/// owner sees it and chooses again.
public struct ShannonFolderBookmarkStore: @unchecked Sendable {
    public enum Restored: Equatable, Sendable {
        case none
        /// Resolved and open (security-scoped access started).
        case folder(URL)
        /// Chosen, but the bookmark cannot be resolved or opened.
        case failed
    }

    public static let defaultsKey = "ShannonFolderHostBookmark"
    private let defaults: UserDefaults
    private let bookmarking: any ShannonFolderBookmarking

    public init(defaults: UserDefaults = .standard, bookmarking: any ShannonFolderBookmarking = ShannonSecurityScopedBookmarks()) {
        self.defaults = defaults
        self.bookmarking = bookmarking
    }

    public var isChosen: Bool { defaults.data(forKey: Self.defaultsKey) != nil }

    /// Remembers a folder the owner chose in the open panel (which grants access for this launch).
    public func save(_ folder: URL) throws {
        defaults.set(try bookmarking.bookmark(for: folder), forKey: Self.defaultsKey)
    }

    /// A `.folder` result has started security-scoped access once; the caller balances it with one `stopAccessing`.
    public func restore() -> Restored {
        guard let data = defaults.data(forKey: Self.defaultsKey) else { return .none }
        guard let resolved = try? bookmarking.resolve(data), bookmarking.startAccessing(resolved.folder) else { return .failed }
        if resolved.isStale {
            // Made again while access is open; if that fails the old one still opened the folder this time.
            if let fresh = try? bookmarking.bookmark(for: resolved.folder) { defaults.set(fresh, forKey: Self.defaultsKey) }
        }
        return .folder(resolved.folder)
    }

    public func stopAccessing(_ folder: URL) {
        bookmarking.stopAccessing(folder)
    }

    public func forget() {
        defaults.removeObject(forKey: Self.defaultsKey)
    }
}

/// Choosing a folder (as on Windows and in the Electron app): an empty folder becomes hers and gets the device's marker;
/// a folder that already has the marker (`.shannon/folder.json`, such as 「デスクトップ/シャノン用」) is taken as it is. A
/// folder with the owner's files and no marker is not.
public enum ShannonFolderHostAdoption {
    public enum Problem: Error, Equatable, Sendable { case notAFolder, notEmpty, cannotMark }

    public static func adopt(_ folder: URL, now: Date = Date()) throws(Problem) {
        guard let real = ShannonFolderHostRoot.realPath(folder.path), let status = ShannonFolderHostRoot.lstatOf(real),
              ShannonFolderHostRoot.kind(status) == S_IFDIR else { throw .notAFolder }
        if (try? ShannonFolderHostRoot(folder: folder)) != nil { return }
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: real)) ?? []).filter { $0 != ".DS_Store" }
        guard names.isEmpty else { throw .notEmpty }
        let marker: [String: Any] = ["purpose": "Shannon dedicated folder", "createdAt": ShannonFolderHostTime.string(now), "version": 1]
        do {
            let folderURL = URL(fileURLWithPath: real).appendingPathComponent(ShannonFolderHostLimits.protectedFolder, isDirectory: true)
            try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: false)
            let data = try JSONSerialization.data(withJSONObject: marker, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: folderURL.appendingPathComponent(ShannonFolderHostLimits.markerFile), options: .withoutOverwriting)
        } catch {
            throw .cannotMark
        }
    }
}
#endif
