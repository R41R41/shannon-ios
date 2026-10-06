#if os(macOS)
import Darwin
import Foundation

/// The fence around her folder on the Mac (`docs/host-folder-contract.md`, 「Who decides what」: the real location is
/// the device's to check). Every path the server sends is spelled-checked again, then walked segment by segment with
/// `lstat`: a link anywhere is refused, `.shannon` in any spelling the disk resolves to it is refused, a package
/// (a bundle Finder shows as one file) is never entered, and the real path must stay inside the real folder. Files are
/// opened with `O_NOFOLLOW_ANY` (no link in any part of the path), must still be the file that was checked, and must have
/// no other hard link.
public struct ShannonFolderHostRoot: Sendable {
    /// The folder's real path.
    public let path: String

    public struct Located: Sendable {
        public let absolute: String
        public let relative: String
        public let status: stat
    }

    /// The real folder, if it is one and carries the device's marker (`.shannon/folder.json`, as the Electron app made it).
    public init(folder: URL) throws(ShannonFolderHostRefusal) {
        guard let real = Self.realPath(folder.path) else { throw ShannonFolderHostRefusal(.folderNotConfigured) }
        guard let root = Self.lstatOf(real), Self.kind(root) == S_IFDIR else { throw ShannonFolderHostRefusal(.folderNotConfigured) }
        let protected = real + "/" + ShannonFolderHostLimits.protectedFolder
        guard let folder = Self.lstatOf(protected), Self.kind(folder) == S_IFDIR,
              let marker = Self.lstatOf(protected + "/" + ShannonFolderHostLimits.markerFile), Self.kind(marker) == S_IFREG
        else { throw ShannonFolderHostRefusal(.folderNotConfigured) }
        path = real
    }

    /// The real location of `relative` inside the folder. `kind == .file` also needs a text extension (else `not_text`).
    public func locate(_ relative: String, kind: ShannonFolderHostPath.Kind) throws(ShannonFolderHostRefusal) -> Located {
        let spelled = relative.replacingOccurrences(of: "\\", with: "/")
        if let first = spelled.split(separator: "/", omittingEmptySubsequences: false).first, ShannonFolderHostPath.isProtectedName(String(first)) {
            throw ShannonFolderHostRefusal(.protectedPath)
        }
        guard let checked = ShannonFolderHostPath.checked(relative, kind: kind == .file ? .entry : kind) else { throw ShannonFolderHostRefusal(.pathNotAllowed) }
        if kind == .file, !ShannonFolderHostPath.hasTextExtension(String(checked.split(separator: "/").last ?? "")) {
            throw ShannonFolderHostRefusal(.notText)
        }
        guard let rootStatus = Self.lstatOf(path), Self.kind(rootStatus) == S_IFDIR else { throw ShannonFolderHostRefusal(.folderNotConfigured) }
        if checked.isEmpty { return Located(absolute: path, relative: "", status: rootStatus) }
        let fence = Self.lstatOf(path + "/" + ShannonFolderHostLimits.protectedFolder)
        let segments = checked.split(separator: "/").map(String.init)
        var current = path
        var status = rootStatus
        for (index, segment) in segments.enumerated() {
            if index > 0, Self.isPackage(current) { throw ShannonFolderHostRefusal(.notAFolder) }
            current += "/" + segment
            var found = stat()
            guard lstat(current, &found) == 0 else {
                let missing = errno == ENOENT || errno == ENOTDIR
                throw ShannonFolderHostRefusal(missing ? .notFound : .ioError, outcome: missing ? .refused : .failed)
            }
            if Self.kind(found) == S_IFLNK { throw ShannonFolderHostRefusal(.linkRefused) }
            // The same directory as `.shannon`, whatever the spelling (case, normalization, case folding of the disk).
            if index == 0, let fence, found.st_dev == fence.st_dev, found.st_ino == fence.st_ino { throw ShannonFolderHostRefusal(.protectedPath) }
            if index < segments.count - 1, Self.kind(found) != S_IFDIR { throw ShannonFolderHostRefusal(.notFound) }
            status = found
        }
        guard let real = Self.realPath(current), Self.isInside(real, root: path) else { throw ShannonFolderHostRefusal(.outsideFolder) }
        return Located(absolute: current, relative: checked, status: status)
    }

    /// The bytes of a located regular file, opened without following a link and checked to be the same file. At most `limit`.
    public func readFile(_ located: Located, limit: Int) throws(ShannonFolderHostRefusal) -> [UInt8] {
        let descriptor = open(located.absolute, O_RDONLY | Self.openNoLink | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else {
            let link = errno == ELOOP
            throw ShannonFolderHostRefusal(link ? .linkRefused : .ioError, outcome: link ? .refused : .failed)
        }
        defer { close(descriptor) }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0, opened.st_dev == located.status.st_dev, opened.st_ino == located.status.st_ino,
              Self.kind(opened) == S_IFREG else { throw ShannonFolderHostRefusal(.linkRefused) }
        // A hard link is the same file as a name somewhere else, perhaps outside her folder: never read.
        guard opened.st_nlink <= 1 else { throw ShannonFolderHostRefusal(.linkRefused) }
        guard Int(opened.st_size) <= limit else { throw ShannonFolderHostRefusal(.tooLarge) }
        var bytes = [UInt8]()
        bytes.reserveCapacity(Int(opened.st_size))
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = buffer.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
            if count < 0 { throw ShannonFolderHostRefusal(.ioError, outcome: .failed) }
            if count == 0 { break }
            bytes.append(contentsOf: buffer[0..<count])
            if bytes.count > limit { throw ShannonFolderHostRefusal(.tooLarge) }
        }
        return bytes
    }

    // MARK: File system facts

    static func lstatOf(_ path: String) -> stat? {
        var status = stat()
        return lstat(path, &status) == 0 ? status : nil
    }

    static func kind(_ status: stat) -> mode_t { status.st_mode & S_IFMT }

    static func realPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// A bundle Finder shows as one file (`.app`, `.rtfd`, a document package): never entered, never read as text.
    static func isPackage(_ path: String) -> Bool {
        (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isPackageKey]).isPackage) == true
    }

    /// A Finder alias: a file that only points somewhere else. Never read as text.
    static func isAlias(_ path: String, status: stat) -> Bool {
        kind(status) == S_IFREG && (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isAliasFileKey]).isAliasFile) == true
    }

    /// Inside, comparing as the disk does (any case, any normalization).
    static func isInside(_ path: String, root: String) -> Bool {
        let fold = { (value: String) in value.decomposedStringWithCanonicalMapping.lowercased() }
        let base = fold(root)
        let target = fold(path)
        return target == base || target.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }
}
#endif
