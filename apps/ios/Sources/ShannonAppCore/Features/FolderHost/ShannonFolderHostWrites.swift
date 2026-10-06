#if os(macOS)
import CryptoKit
import Darwin
import Foundation

/// The changing operations of her folder on the Mac (A18 S3; `docs/host-folder-contract.md`, 「Operations」): `create`,
/// `update`, `move`, `delete`. Inside the same fence as reading, and nothing is ever destroyed: an overwrite or a delete
/// first moves the old file or folder into `.shannon/trash/`, behind the fence, where only the owner restores it.
/// Never the v1 `write` (Syzygy ADR-0007: no story goes into the PC or Mac folder).
public enum ShannonFolderHostWrites {
    /// The device's own totals (as on Windows): what her folder may hold outside `.shannon`.
    public static let totalBytes = 200 * 1_024 * 1_024
    public static let totalFiles = 5_000

    /// The totals a write is checked against (`folder_full`); tests pass smaller ones.
    public struct Quota: Sendable {
        public let files: Int
        public let bytes: Int
        public static let standard = Quota(files: totalFiles, bytes: totalBytes)
        public init(files: Int, bytes: Int) {
            self.files = files
            self.bytes = bytes
        }
    }

    // MARK: create

    public static func create(
        _ root: ShannonFolderHostRoot, relativePath: String, content: String?, contentSha256: String?, bytes: Int?, quota: Quota = .standard
    ) throws(ShannonFolderHostRefusal) -> ShannonFolderHostWriteResult {
        let data = try checkedContent(content, sha256: contentSha256, bytes: bytes)
        let target = try root.target(relativePath, kind: .file)
        guard target.existing == nil else { throw ShannonFolderHostRefusal(.alreadyExists) }
        let usage = root.usage(stoppingAfter: quota.files)
        guard usage.files + 1 <= quota.files, usage.bytes + data.count <= quota.bytes else { throw ShannonFolderHostRefusal(.folderFull) }
        try root.makeParents(target)
        let checked = try root.target(relativePath, kind: .file)
        guard checked.existing == nil else { throw ShannonFolderHostRefusal(.alreadyExists) }
        try writeNew(checked.absolute, data)
        return .init(sha256: digest(data))
    }

    // MARK: update

    /// Replaces a text file, keeping the original in the trash. The file is never missing at its path: the new text is
    /// written under the original's trash name and swapped in (`replace`). With `expectedSha256`, a file the owner changed
    /// since she read it is left alone (`changed_since_read`).
    public static func update(
        _ root: ShannonFolderHostRoot, relativePath: String, content: String?, contentSha256: String?, bytes: Int?,
        expectedSha256: String?, now: Date, quota: Quota = .standard
    ) throws(ShannonFolderHostRefusal) -> ShannonFolderHostWriteResult {
        let data = try checkedContent(content, sha256: contentSha256, bytes: bytes)
        let target = try root.target(relativePath, kind: .file)
        guard let existing = target.existing else { throw ShannonFolderHostRefusal(.notFound) }
        switch ShannonFolderHostRoot.kind(existing) {
        case S_IFREG: break
        case S_IFDIR: throw ShannonFolderHostRefusal(ShannonFolderHostRoot.isPackage(target.absolute) ? .notText : .notAFile)
        default: throw ShannonFolderHostRefusal(.notAFile)
        }
        if ShannonFolderHostRoot.isAlias(target.absolute, status: existing) { throw ShannonFolderHostRefusal(.notText) }
        let file = try root.locate(relativePath, kind: .file)
        let old = try root.readFile(file, limit: ShannonFolderHostLimits.fileBytes)
        guard ShannonFolderHostOperations.isText(old) else { throw ShannonFolderHostRefusal(.notText) }
        if let expectedSha256, expectedSha256.lowercased() != digest(Data(old)) { throw ShannonFolderHostRefusal(.changedSinceRead) }
        let usage = root.usage(stoppingAfter: quota.files)
        guard usage.bytes - old.count + data.count <= quota.bytes else { throw ShannonFolderHostRefusal(.folderFull) }
        return .init(sha256: digest(data), trashedAs: try root.replace(file, with: data, now: now))
    }

    // MARK: move

    /// Moves or renames a file or a folder inside her folder, making missing parent folders. Never overwrites. A text file
    /// stays a text file; a file of another kind (one the owner placed) keeps its extension.
    public static func move(_ root: ShannonFolderHostRoot, relativePath: String, toRelativePath: String?) throws(ShannonFolderHostRefusal) -> ShannonFolderHostWriteResult {
        guard let toRelativePath else { throw ShannonFolderHostRefusal(.pathNotAllowed) }
        let source = try root.locate(relativePath, kind: .entry)
        let target = try root.target(toRelativePath, kind: .entry)
        guard target.existing == nil else { throw ShannonFolderHostRefusal(.alreadyExists) }
        let fold = { (path: String) in path.decomposedStringWithCanonicalMapping.lowercased() }
        if fold(target.relative) == fold(source.relative) || fold(target.relative).hasPrefix(fold(source.relative) + "/") {
            throw ShannonFolderHostRefusal(.pathNotAllowed)
        }
        let isFolder = ShannonFolderHostRoot.kind(source.status) == S_IFDIR && !ShannonFolderHostRoot.isPackage(source.absolute)
        if !isFolder {
            let from = String(source.relative.split(separator: "/").last ?? "")
            let to = String(target.relative.split(separator: "/").last ?? "")
            if ShannonFolderHostPath.hasTextExtension(from) {
                guard ShannonFolderHostPath.hasTextExtension(to) else { throw ShannonFolderHostRefusal(.extensionNotAllowed) }
            } else {
                guard fileExtension(from) == fileExtension(to) else { throw ShannonFolderHostRefusal(.extensionNotAllowed) }
            }
        }
        try root.makeParents(target)
        let checked = try root.target(toRelativePath, kind: .entry)
        guard checked.existing == nil else { throw ShannonFolderHostRefusal(.alreadyExists) }
        guard renamex_np(source.absolute, checked.absolute, UInt32(RENAME_EXCL) | ShannonFolderHostRoot.renameNoLink) == 0 else {
            throw ShannonFolderHostRoot.refusal(errno: errno)
        }
        return .init()
    }

    // MARK: delete

    /// A file or a folder goes into the trash. Nothing is erased.
    public static func delete(_ root: ShannonFolderHostRoot, relativePath: String, now: Date) throws(ShannonFolderHostRefusal) -> ShannonFolderHostWriteResult {
        let entry = try root.locate(relativePath, kind: .entry)
        guard !entry.relative.isEmpty else { throw ShannonFolderHostRefusal(.pathNotAllowed) }
        return .init(trashedAs: try root.trash(entry.absolute, relative: entry.relative, now: now))
    }

    // MARK: Content

    /// The text as sent: its digest and length must match (`content_mismatch`), at most 1 MiB (`too_large`), no NUL (`not_text`).
    static func checkedContent(_ content: String?, sha256: String?, bytes: Int?) throws(ShannonFolderHostRefusal) -> Data {
        guard let content, let sha256, let bytes else { throw ShannonFolderHostRefusal(.contentMismatch) }
        let data = Data(content.utf8)
        guard data.count == bytes, digest(data) == sha256.lowercased() else { throw ShannonFolderHostRefusal(.contentMismatch) }
        guard data.count <= ShannonFolderHostLimits.fileBytes else { throw ShannonFolderHostRefusal(.tooLarge) }
        guard ShannonFolderHostOperations.isText([UInt8](data)) else { throw ShannonFolderHostRefusal(.notText) }
        return data
    }

    static func writeAll(_ descriptor: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { buffer -> Bool in
            var offset = 0
            while offset < buffer.count {
                let count = write(descriptor, buffer.baseAddress! + offset, buffer.count - offset)
                if count <= 0 { return false }
                offset += count
            }
            return true
        }
    }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func fileExtension(_ name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot > name.startIndex else { return "" }
        return name[dot...].lowercased()
    }

    /// A new file, never over anything (`O_EXCL`), never through a link anywhere in the path (`O_NOFOLLOW_ANY`: a folder
    /// above it swapped for a link after the check is refused too). A partial file is removed.
    static func writeNew(_ path: String, _ data: Data) throws(ShannonFolderHostRefusal) {
        let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | ShannonFolderHostRoot.openNoLink | O_CLOEXEC, 0o644)
        guard descriptor >= 0 else { throw ShannonFolderHostRoot.refusal(errno: errno) }
        let synced = writeAll(descriptor, data) && fsync(descriptor) == 0
        close(descriptor)
        guard synced else {
            unlink(path)
            throw ShannonFolderHostRefusal(.ioError, outcome: .failed)
        }
    }
}

extension ShannonFolderHostRoot {
    /// Where a write goes: the fence of `locate` over the part that exists, and nothing below a part that does not.
    public struct Target: Sendable {
        public let absolute: String
        public let relative: String
        /// The entry at the path, when one is there.
        public let existing: stat?
        let segments: [String]
    }

    /// `kind == .file` needs a text extension (else `extension_not_allowed`); `.entry` is a file or a folder of any name.
    public func target(_ relative: String, kind: ShannonFolderHostPath.Kind) throws(ShannonFolderHostRefusal) -> Target {
        let spelled = relative.replacingOccurrences(of: "\\", with: "/")
        if let first = spelled.split(separator: "/", omittingEmptySubsequences: false).first, ShannonFolderHostPath.isProtectedName(String(first)) {
            throw ShannonFolderHostRefusal(.protectedPath)
        }
        guard let checked = ShannonFolderHostPath.checked(relative, kind: .entry), !checked.isEmpty else { throw ShannonFolderHostRefusal(.pathNotAllowed) }
        let segments = checked.split(separator: "/").map(String.init)
        if kind == .file, !ShannonFolderHostPath.hasTextExtension(segments[segments.count - 1]) { throw ShannonFolderHostRefusal(.extensionNotAllowed) }
        guard let rootStatus = Self.lstatOf(path), Self.kind(rootStatus) == S_IFDIR else { throw ShannonFolderHostRefusal(.folderNotConfigured) }
        let fence = Self.lstatOf(path + "/" + ShannonFolderHostLimits.protectedFolder)
        var current = path
        var deepest = path
        var existing: stat? = rootStatus
        for (index, segment) in segments.enumerated() {
            guard let parent = existing else {
                current += "/" + segment
                continue
            }
            if index > 0, Self.kind(parent) != S_IFDIR || Self.isPackage(current) { throw ShannonFolderHostRefusal(.notAFolder) }
            current += "/" + segment
            var found = stat()
            guard lstat(current, &found) == 0 else {
                guard errno == ENOENT else { throw ShannonFolderHostRefusal(.ioError, outcome: .failed) }
                existing = nil
                continue
            }
            if Self.kind(found) == S_IFLNK { throw ShannonFolderHostRefusal(.linkRefused) }
            if index == 0, let fence, found.st_dev == fence.st_dev, found.st_ino == fence.st_ino { throw ShannonFolderHostRefusal(.protectedPath) }
            existing = found
            deepest = current
        }
        guard let real = Self.realPath(deepest), Self.isInside(real, root: path) else { throw ShannonFolderHostRefusal(.outsideFolder) }
        return Target(absolute: current, relative: checked, existing: existing, segments: segments)
    }

    /// Makes the missing folders above a target, one at a time, each checked to be a real folder (not a link) inside hers.
    /// Every folder is made in the folder opened before it (`mkdirat`, then `openat` without following a link), from her
    /// folder opened with `O_NOFOLLOW_ANY`: a folder swapped for a link by another program is never made through.
    func makeParents(_ target: Target) throws(ShannonFolderHostRefusal) {
        var parent = try Self.openFolder(path)
        defer { close(parent) }
        var current = path
        for segment in target.segments.dropLast() {
            current += "/" + segment
            if mkdirat(parent, segment, 0o755) != 0, errno != EEXIST { throw Self.refusal(errno: errno) }
            var made = stat()
            guard fstatat(parent, segment, &made, AT_SYMLINK_NOFOLLOW) == 0 else { throw ShannonFolderHostRefusal(.ioError, outcome: .failed) }
            if Self.kind(made) == S_IFLNK { throw ShannonFolderHostRefusal(.linkRefused) }
            guard Self.kind(made) == S_IFDIR, !Self.isPackage(current) else { throw ShannonFolderHostRefusal(.notAFolder) }
            let next = openat(parent, segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw errno == ENOTDIR ? ShannonFolderHostRefusal(.notAFolder) : Self.refusal(errno: errno) }
            close(parent)
            parent = next
        }
        guard let real = Self.realPath(current), Self.isInside(real, root: path) else { throw ShannonFolderHostRefusal(.outsideFolder) }
    }

    // MARK: No link anywhere

    /// Her folder's path is real (`init` resolves it), so a link anywhere below it is another program's doing, perhaps made
    /// after the check: every call that writes refuses a link in any part of its path, not only the last (`O_NOFOLLOW_ANY`,
    /// `RENAME_NOFOLLOW_ANY`, both since macOS 11; the app needs 14). A system that did not know a flag would fail the call
    /// (`EINVAL`), which is refused like any failure; a call is never repeated without them.
    static let openNoLink = O_NOFOLLOW_ANY
    static let renameNoLink = UInt32(RENAME_NOFOLLOW_ANY)

    /// A folder opened for `…at` calls, with no link anywhere in its path.
    static func openFolder(_ path: String) throws(ShannonFolderHostRefusal) -> Int32 {
        let descriptor = open(path, O_RDONLY | O_DIRECTORY | openNoLink | O_CLOEXEC)
        guard descriptor >= 0 else { throw errno == ENOTDIR ? ShannonFolderHostRefusal(.notAFolder) : refusal(errno: errno) }
        return descriptor
    }

    /// A failed call: a link met on the way (`ELOOP`) is `link_refused`, something already there `already_exists`.
    static func refusal(errno code: Int32) -> ShannonFolderHostRefusal {
        switch code {
        case ELOOP: ShannonFolderHostRefusal(.linkRefused)
        case EEXIST: ShannonFolderHostRefusal(.alreadyExists)
        default: ShannonFolderHostRefusal(.ioError, outcome: .failed)
        }
    }

    /// Files and bytes outside `.shannon` (links not followed, not counted). Stops counting once past the file total.
    func usage(stoppingAfter limit: Int = ShannonFolderHostWrites.totalFiles) -> (files: Int, bytes: Int) {
        var files = 0
        var bytes = 0
        var folders = [path]
        while let folder = folders.popLast(), files <= limit {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder) else { continue }
            for name in names {
                if folder == path, ShannonFolderHostPath.isProtectedName(name) { continue }
                let absolute = folder + "/" + name
                guard let status = Self.lstatOf(absolute) else { continue }
                switch Self.kind(status) {
                case S_IFDIR: folders.append(absolute)
                case S_IFREG:
                    files += 1
                    bytes += Int(status.st_size)
                default: continue
                }
            }
        }
        return (files, bytes)
    }

    /// `update`'s exchange (`docs/host-folder-contract.md`, 「The Mac application」):
    /// 1. the new text is written to a new file in `.shannon/trash/`, under the name the original will have there (behind
    ///    the fence, so never listed or searched), with the original's permissions and, if it has them, its extended
    ///    attributes (Finder tags among them);
    /// 2. the two are swapped in one call (`RENAME_SWAP`): the new text is at the path and the original at its trash name.
    /// The path is never empty. Any failure before the swap removes the new file and leaves the original where it was; after
    /// the swap the original is in the trash, at the location returned (and so reported and logged as `trashedAs`).
    func replace(_ file: Located, with data: Data, now: Date) throws(ShannonFolderHostRefusal) -> String {
        let original = open(file.absolute, O_RDONLY | Self.openNoLink | O_NONBLOCK | O_CLOEXEC)
        guard original >= 0 else { throw errno == ENOENT ? ShannonFolderHostRefusal(.changedSinceRead) : Self.refusal(errno: errno) }
        defer { close(original) }
        var opened = stat()
        guard fstat(original, &opened) == 0 else { throw ShannonFolderHostRefusal(.ioError, outcome: .failed) }
        // Not the file that was read: another program put a file there since.
        guard Self.same(opened, file.status) else { throw ShannonFolderHostRefusal(.changedSinceRead) }
        let trash = try openTrash()
        defer { close(trash) }
        var staged: (name: String, descriptor: Int32)?
        for name in Self.trashNames(file.relative, now: now) {
            let descriptor = openat(trash, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            if descriptor >= 0 { staged = (name, descriptor); break }
            guard errno == EEXIST else { throw Self.refusal(errno: errno) }
        }
        guard let staged else { throw ShannonFolderHostRefusal(.ioError, outcome: .failed) }
        // Extended attributes and ACLs as they are, if they can be copied (a text file may have none); the permissions always.
        _ = fcopyfile(original, staged.descriptor, nil, copyfile_flags_t(COPYFILE_XATTR | COPYFILE_ACL))
        let written = fchmod(staged.descriptor, opened.st_mode & 0o777) == 0
            && ShannonFolderHostWrites.writeAll(staged.descriptor, data) && fsync(staged.descriptor) == 0
        close(staged.descriptor)
        guard written else {
            unlinkat(trash, staged.name, 0)
            throw ShannonFolderHostRefusal(.ioError, outcome: .failed)
        }
        guard renameatx_np(trash, staged.name, AT_FDCWD, file.absolute, UInt32(RENAME_SWAP) | Self.renameNoLink) == 0 else {
            let code = errno
            unlinkat(trash, staged.name, 0)
            throw code == ENOENT ? ShannonFolderHostRefusal(.changedSinceRead) : Self.refusal(errno: code)
        }
        // The trash name now holds what was at the path. Another program could have put a file there after the check above:
        // then that file is put back and her text taken out again. If even that fails, that file stays in the trash, named.
        var swapped = stat()
        if fstatat(trash, staged.name, &swapped, AT_SYMLINK_NOFOLLOW) != 0 || !Self.same(swapped, opened) {
            if renameatx_np(trash, staged.name, AT_FDCWD, file.absolute, UInt32(RENAME_SWAP) | Self.renameNoLink) == 0 {
                unlinkat(trash, staged.name, 0)
                throw ShannonFolderHostRefusal(.changedSinceRead)
            }
        }
        return ShannonFolderHostLimits.protectedFolder + "/trash/" + staged.name
    }

    static func same(_ one: stat, _ other: stat) -> Bool { one.st_dev == other.st_dev && one.st_ino == other.st_ino }

    /// Moves a file or a folder into `.shannon/trash/<time>_<path flattened>` and returns that relative location.
    func trash(_ absolute: String, relative: String, now: Date) throws(ShannonFolderHostRefusal) -> String {
        let trash = try openTrash()
        defer { close(trash) }
        for name in Self.trashNames(relative, now: now) {
            if renameatx_np(AT_FDCWD, absolute, trash, name, UInt32(RENAME_EXCL) | Self.renameNoLink) == 0 {
                return ShannonFolderHostLimits.protectedFolder + "/trash/" + name
            }
            guard errno == EEXIST else { throw Self.refusal(errno: errno) }
        }
        throw ShannonFolderHostRefusal(.ioError, outcome: .failed)
    }

    /// `.shannon/trash`, made if missing, opened as a real folder (no link anywhere on the way).
    func openTrash() throws(ShannonFolderHostRefusal) -> Int32 {
        let fence = try Self.openFolder(path + "/" + ShannonFolderHostLimits.protectedFolder)
        defer { close(fence) }
        if mkdirat(fence, "trash", 0o755) != 0, errno != EEXIST { throw Self.refusal(errno: errno) }
        var made = stat()
        guard fstatat(fence, "trash", &made, AT_SYMLINK_NOFOLLOW) == 0 else { throw Self.refusal(errno: errno) }
        // `openat` with `O_NOFOLLOW | O_DIRECTORY` says only 「not a folder」 for a link: the link is named first.
        if Self.kind(made) == S_IFLNK { throw ShannonFolderHostRefusal(.linkRefused) }
        let trash = openat(fence, "trash", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard trash >= 0 else { throw errno == ENOTDIR ? ShannonFolderHostRefusal(.linkRefused) : Self.refusal(errno: errno) }
        return trash
    }

    /// The names a trashed entry may take, in order: `<time>_<path flattened>`, then with a number when two would meet.
    static func trashNames(_ relative: String, now: Date) -> [String] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd'T'HHmmssSSS'Z'"
        let stamp = formatter.string(from: now)
        var flat = relative.replacingOccurrences(of: "/", with: "_")
        // A name of at most 200 bytes, keeping the end (the extension) of a long path.
        while flat.utf8.count > 200 { flat.removeFirst() }
        return (1...100).map { $0 == 1 ? "\(stamp)_\(flat)" : "\(stamp)-\($0)_\(flat)" }
    }
}
#endif
