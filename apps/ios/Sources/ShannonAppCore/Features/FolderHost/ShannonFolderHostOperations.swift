#if os(macOS)
import CryptoKit
import Darwin
import Foundation

/// The reading operations of her folder on the Mac (`docs/host-folder-contract.md`, 「Operations」): `list`, `read`,
/// `search`, each inside the fence of `ShannonFolderHostRoot`. Nothing is written, opened as a program, or interpreted.
/// Pure apart from reading the disk, so the bounds are tested with a temporary folder.
public enum ShannonFolderHostOperations {
    /// Entries visited by one listing or search before it stops (the device's own total, as on Windows).
    static let walkEntries = 5_000

    // MARK: list

    public static func list(_ root: ShannonFolderHostRoot, relativePath: String, recursive: Bool, limit: Int) throws(ShannonFolderHostRefusal) -> ShannonFolderHostListResult {
        let folder = try root.locate(relativePath, kind: .folder)
        guard ShannonFolderHostRoot.kind(folder.status) == S_IFDIR, folder.relative.isEmpty || !ShannonFolderHostRoot.isPackage(folder.absolute) else {
            throw ShannonFolderHostRefusal(.notAFolder)
        }
        let bound = max(1, min(limit, ShannonFolderHostLimits.listEntries))
        var entries: [ShannonFolderHostListResult.Entry] = []
        var walkedAll = true
        walk(root, from: folder, recursive: recursive) { item in
            if entries.count >= walkEntries { walkedAll = false; return false }
            guard isReportablePath(item.relative) else { return true }
            let file = item.type == "file"
            entries.append(.init(path: item.relative, type: item.type, bytes: file && !item.isPackage ? Int(item.status.st_size) : nil,
                                 modifiedAt: ShannonFolderHostTime.string(modified(item.status))))
            return true
        }
        entries.sort { $0.path < $1.path }
        return .init(entries: Array(entries.prefix(bound)), truncated: entries.count > bound || !walkedAll)
    }

    // MARK: read

    /// One text file from `offset`, at most `maxBytes`, cut at a character boundary, and short enough that the report,
    /// escaped, stays inside the report cap (`reportBytes` measures what would be sent).
    public static func read(
        _ root: ShannonFolderHostRoot, relativePath: String, offset requested: Int, maxBytes: Int,
        reportBytes: (ShannonFolderHostReadResult) -> Int = { readReportBytes($0) }
    ) throws(ShannonFolderHostRefusal) -> ShannonFolderHostReadResult {
        let file = try root.locate(relativePath, kind: .file)
        switch ShannonFolderHostRoot.kind(file.status) {
        case S_IFREG: break
        case S_IFDIR: throw ShannonFolderHostRefusal(ShannonFolderHostRoot.isPackage(file.absolute) ? .notText : .notAFile)
        default: throw ShannonFolderHostRefusal(.notAFile)
        }
        if ShannonFolderHostRoot.isAlias(file.absolute, status: file.status) { throw ShannonFolderHostRefusal(.notText) }
        let bytes = try root.readFile(file, limit: ShannonFolderHostLimits.fileBytes)
        guard isText(bytes) else { throw ShannonFolderHostRefusal(.notText) }
        let total = bytes.count
        var start = min(max(0, requested), total)
        while start < total, isContinuation(bytes[start]) { start += 1 }
        var end = boundary(bytes, atOrBefore: min(total, start + max(1, min(maxBytes, ShannonFolderHostLimits.readBytes))), after: start)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let modifiedAt = ShannonFolderHostTime.string(modified(file.status))
        func result(_ end: Int) -> ShannonFolderHostReadResult {
            .init(content: String(decoding: bytes[start..<end], as: UTF8.self), offset: start, nextOffset: end < total ? end : nil,
                  totalBytes: total, sha256: digest, modifiedAt: modifiedAt)
        }
        var made = result(end)
        // Escaping may grow the text up to six times (control characters): return less and let her read on.
        while reportBytes(made) > ShannonFolderHostLimits.reportBodyBytes {
            let excess = reportBytes(made) - ShannonFolderHostLimits.reportBodyBytes
            let shorter = boundary(bytes, atOrBefore: max(start, end - max(excess, (end - start) / 8, 1)), after: start)
            guard shorter < end else { break }
            end = shorter
            made = result(end)
        }
        return made
    }

    /// The size of a report carrying this read, with room for the longest scope key.
    public static func readReportBytes(_ result: ShannonFolderHostReadResult) -> Int {
        ((try? ShannonFolderHostReport.done(.read(result)).body(scopeKey: "owner"))?.count ?? Int.max) + 256
    }

    // MARK: search

    /// Case-insensitive match (after NFKC) in paths and in the text of text files below `relativePath`. Stops at whichever
    /// comes first: `limit` hits, 500 files read, 8 MiB read, 2 seconds (`now` measures it).
    public static func search(
        _ root: ShannonFolderHostRoot, query: String, relativePath: String, limit: Int, now: () -> Date = Date.init
    ) throws(ShannonFolderHostRefusal) -> ShannonFolderHostSearchResult {
        let needle = normalized(query)
        guard !needle.isEmpty else { throw ShannonFolderHostRefusal(.pathNotAllowed) }
        let folder = try root.locate(relativePath, kind: .folder)
        guard ShannonFolderHostRoot.kind(folder.status) == S_IFDIR, folder.relative.isEmpty || !ShannonFolderHostRoot.isPackage(folder.absolute) else {
            throw ShannonFolderHostRefusal(.notAFolder)
        }
        let started = now()
        let bound = max(1, min(limit, ShannonFolderHostLimits.searchHits))
        var hits: [ShannonFolderHostSearchResult.Hit] = []
        var filesScanned = 0
        var bytesRead = 0
        var visited = 0
        var truncated = false
        walk(root, from: folder, recursive: true) { item in
            visited += 1
            if hits.count >= bound || filesScanned >= ShannonFolderHostLimits.searchFiles || bytesRead >= ShannonFolderHostLimits.searchBytes
                || visited > walkEntries || now().timeIntervalSince(started) >= ShannonFolderHostLimits.searchSeconds {
                truncated = true
                return false
            }
            guard isReportablePath(item.relative) else { return true }
            let text = item.type == "file" && !item.isPackage && ShannonFolderHostPath.hasTextExtension(item.name)
                && !ShannonFolderHostRoot.isAlias(item.absolute, status: item.status)
            if item.type == "file", !text { return true }
            var fileHits = 0
            if normalized(item.relative).contains(needle) {
                hits.append(.init(path: item.relative, line: nil, snippet: snippet(item.name, around: query)))
                fileHits += 1
            }
            guard text, Int(item.status.st_size) <= ShannonFolderHostLimits.fileBytes,
                  bytesRead + Int(item.status.st_size) <= ShannonFolderHostLimits.searchBytes else { return true }
            guard let located = try? root.locate(item.relative, kind: .file), let bytes = try? root.readFile(located, limit: ShannonFolderHostLimits.fileBytes) else { return true }
            filesScanned += 1
            bytesRead += bytes.count
            guard isText(bytes) else { return true }
            let content = String(decoding: bytes, as: UTF8.self)
            for (index, line) in content.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                guard fileHits < ShannonFolderHostLimits.searchHitsPerFile, hits.count < bound else { break }
                let line = String(line)
                guard normalized(line).contains(needle) else { continue }
                hits.append(.init(path: item.relative, line: index + 1, snippet: snippet(line, around: query)))
                fileHits += 1
            }
            return true
        }
        if hits.count > bound { hits = Array(hits.prefix(bound)) }
        return .init(hits: hits, filesScanned: filesScanned, truncated: truncated || hits.count >= bound)
    }

    // MARK: Walking

    struct Item {
        let relative: String
        let absolute: String
        let name: String
        let status: stat
        let isPackage: Bool
        var type: String { ShannonFolderHostRoot.kind(status) == S_IFDIR && !isPackage ? "folder" : "file" }
    }

    /// Visits what is below `from`, sorted by name in each folder. Links and anything not a file or a folder are left out;
    /// `.shannon` at the top is never shown; a package is one file and never entered. `visit` returns false to stop.
    static func walk(_ root: ShannonFolderHostRoot, from: ShannonFolderHostRoot.Located, recursive: Bool, visit: (Item) -> Bool) {
        var folders: [(absolute: String, relative: String)] = [(from.absolute, from.relative)]
        while !folders.isEmpty {
            let folder = folders.removeFirst()
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.absolute) else { continue }
            for name in names.sorted() {
                if folder.relative.isEmpty, ShannonFolderHostPath.isProtectedName(name) { continue }
                let absolute = folder.absolute + "/" + name
                guard let status = ShannonFolderHostRoot.lstatOf(absolute) else { continue }
                let kind = ShannonFolderHostRoot.kind(status)
                guard kind == S_IFREG || kind == S_IFDIR else { continue }
                let item = Item(relative: folder.relative.isEmpty ? name : folder.relative + "/" + name, absolute: absolute, name: name,
                                status: status, isPackage: kind == S_IFDIR && ShannonFolderHostRoot.isPackage(absolute))
                guard visit(item) else { return }
                if recursive, item.type == "folder" { folders.append((absolute, item.relative)) }
            }
        }
    }

    // MARK: Small rules

    /// The server refuses a path over 240 characters or with a control character in a result: such an entry is left out.
    static func isReportablePath(_ path: String) -> Bool {
        !path.isEmpty && path.utf16.count <= ShannonFolderHostLimits.pathCharacters && !path.unicodeScalars.contains { $0.value <= 0x1F }
    }

    static func normalized(_ text: String) -> String {
        text.precomposedStringWithCompatibilityMapping.lowercased()
    }

    /// At most 160 characters of one line around the match.
    static func snippet(_ line: String, around query: String) -> String {
        let flat = line.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\t", with: " ")
            .unicodeScalars.filter { $0.value > 0x1F }.map(String.init).joined()
        let limit = ShannonFolderHostLimits.snippetCharacters
        guard flat.utf16.count > limit else { return flat }
        let found = flat.range(of: query, options: [.caseInsensitive, .widthInsensitive])
        let center = found.map { flat.distance(from: flat.startIndex, to: $0.lowerBound) } ?? 0
        let start = flat.index(flat.startIndex, offsetBy: max(0, center - 50), limitedBy: flat.endIndex) ?? flat.startIndex
        var piece = String(flat[start...])
        while piece.utf16.count > limit { piece.removeLast() }
        return piece
    }

    static func isContinuation(_ byte: UInt8) -> Bool { byte & 0xC0 == 0x80 }

    /// Valid UTF-8 with no NUL: what the contract calls a text file's content (`not_text` otherwise).
    public static func isText(_ bytes: [UInt8]) -> Bool {
        guard !bytes.contains(0) else { return false }
        var iterator = bytes.makeIterator()
        var decoder = UTF8()
        while true {
            switch decoder.decode(&iterator) {
            case .scalarValue: continue
            case .emptyInput: return true
            case .error: return false
            }
        }
    }

    /// The last character boundary at or before `index`, but past `start` by at least one character.
    static func boundary(_ bytes: [UInt8], atOrBefore index: Int, after start: Int) -> Int {
        var end = min(index, bytes.count)
        while end > start, end < bytes.count, isContinuation(bytes[end]) { end -= 1 }
        if end <= start, start < bytes.count {
            end = start + 1
            while end < bytes.count, isContinuation(bytes[end]) { end += 1 }
        }
        return end
    }

    static func modified(_ status: stat) -> Date {
        Date(timeIntervalSince1970: TimeInterval(status.st_mtimespec.tv_sec) + TimeInterval(status.st_mtimespec.tv_nsec) / 1_000_000_000)
    }
}
#endif
