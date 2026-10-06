#if os(macOS)
import Foundation

/// The codes a folder device may report (`docs/host-folder-contract.md`, 「Codes」 and 「v2 codes」). There is no free text.
public enum ShannonFolderHostCode: String, Codable, CaseIterable, Sendable {
    case pathNotAllowed = "path_not_allowed"
    case outsideFolder = "outside_folder"
    case linkRefused = "link_refused"
    case extensionNotAllowed = "extension_not_allowed"
    case tooLarge = "too_large"
    case folderNotConfigured = "folder_not_configured"
    case contentMismatch = "content_mismatch"
    case unsupportedOperation = "unsupported_operation"
    case ioError = "io_error"
    case unknown
    case notFound = "not_found"
    case alreadyExists = "already_exists"
    case notText = "not_text"
    case notAFile = "not_a_file"
    case notAFolder = "not_a_folder"
    case changedSinceRead = "changed_since_read"
    case folderFull = "folder_full"
    case protectedPath = "protected_path"
    case stoppedLocally = "stopped_locally"
}

/// Why the device did not carry out a step: the report's `outcome` (`refused`: its own checks said no; `failed`: it tried) and code.
public struct ShannonFolderHostRefusal: Error, Equatable, Sendable {
    public enum Outcome: String, Sendable { case refused, failed }
    public let outcome: Outcome
    public let code: ShannonFolderHostCode

    public init(_ code: ShannonFolderHostCode, outcome: Outcome = .refused) {
        self.code = code
        self.outcome = outcome
    }
}

/// The bounds shared with the server and the Windows device (`autonomyHostFolderPath.ts`, `hostFolderOperationResults.ts`).
public enum ShannonFolderHostLimits {
    public static let textExtensions = [".md", ".txt", ".json", ".csv", ".yaml", ".yml"]
    /// Lengths are counted as JavaScript counts them (UTF-16 code units), so the server and the Mac agree.
    public static let pathCharacters = 240
    public static let segmentCharacters = 120
    public static let segments = 8
    /// One file the device reads, searches or writes, as UTF-8.
    public static let fileBytes = 1_048_576
    public static let readBytes = 262_144
    /// The body of a report: a read of 256 KiB of text, escaped.
    public static let reportBodyBytes = 640 * 1_024
    public static let listEntries = 500
    public static let searchHits = 50
    public static let snippetCharacters = 160
    public static let searchFiles = 500
    public static let searchBytes = 8 * 1_048_576
    public static let searchSeconds: TimeInterval = 2
    public static let searchHitsPerFile = 3
    /// The device's own folder inside hers: its marker and her trash. No requested operation may name it.
    public static let protectedFolder = ".shannon"
    public static let markerFile = "folder.json"
}

/// The server's path rules by spelling alone (`hostFolderPath` in `services/api/src/autonomyHostFolderPath.ts`), so the Mac
/// checks again exactly what the server checked. `services/api/tests/fixtures/host-folder-paths-v1/cases.json` is the oracle
/// both sides are tested against. The real location is checked afterwards (`ShannonFolderHostRoot`).
public enum ShannonFolderHostPath {
    public enum Kind: String, Sendable {
        /// A text file with content (read).
        case file
        /// A file or a folder of any extension.
        case entry
        /// The same, or `""` for the folder itself (list, search).
        case folder
    }

    /// The path with `/` separators, or nil when the server's rules refuse it.
    public static func checked(_ value: String, kind: Kind) -> String? {
        if kind == .folder, value.isEmpty { return "" }
        guard !value.isEmpty, value.utf16.count <= ShannonFolderHostLimits.pathCharacters else { return nil }
        guard !value.unicodeScalars.contains(where: isForbidden) else { return nil }
        let path = value.replacingOccurrences(of: "\\", with: "/")
        guard !path.hasPrefix("/"), !path.hasPrefix("~") else { return nil }
        let segments = path.components(separatedBy: "/")
        guard segments.count <= ShannonFolderHostLimits.segments else { return nil }
        for segment in segments {
            guard !segment.isEmpty, segment != ".", segment != "..",
                  segment.utf16.count <= ShannonFolderHostLimits.segmentCharacters else { return nil }
            guard trimmed(segment) == segment, segment.unicodeScalars.last != "." else { return nil }
            let stem = trimmed(segment.components(separatedBy: ".")[0])
            guard !isReservedName(stem) else { return nil }
        }
        guard segments[0].lowercased() != ShannonFolderHostLimits.protectedFolder else { return nil }
        if kind == .file, !hasTextExtension(segments[segments.count - 1]) { return nil }
        return segments.joined(separator: "/")
    }

    /// `.md .txt .json .csv .yaml .yml` in any case, with a name before it.
    public static func hasTextExtension(_ name: String) -> Bool {
        let scalars = Array(name.unicodeScalars)
        guard let dot = scalars.lastIndex(of: "."), dot >= 1 else { return false }
        let suffix = String(String.UnicodeScalarView(scalars[dot...])).lowercased()
        return ShannonFolderHostLimits.textExtensions.contains(suffix)
    }

    /// The Mac's own fence for `.shannon`, stricter than the server's: any case, any Unicode normalization, any width, and the
    /// case folding of the file system (APFS folds 「ſ」 to 「s」), so no spelling that the disk resolves to it is let through.
    public static func isProtectedName(_ name: String) -> Bool {
        let folded = name.precomposedStringWithCompatibilityMapping
            .folding(options: [.caseInsensitive, .widthInsensitive], locale: nil)
            .precomposedStringWithCompatibilityMapping
        return folded == ShannonFolderHostLimits.protectedFolder || name.lowercased() == ShannonFolderHostLimits.protectedFolder
    }

    // Control characters, DEL and C1, and what Windows refuses in a name; `:` also covers drives and alternate streams.
    private static func isForbidden(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value <= 0x1F || (0x7F...0x9F).contains(scalar.value) || "<>:\"|?*".unicodeScalars.contains(scalar)
    }

    /// JavaScript's `trim()`: its white space and line terminators.
    private static let javaScriptWhiteSpace: Set<UInt32> = [
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
        0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ]

    private static func trimmed(_ value: String) -> String {
        var scalars = Substring(value).unicodeScalars
        while let first = scalars.first, javaScriptWhiteSpace.contains(first.value) { scalars.removeFirst() }
        while let last = scalars.last, javaScriptWhiteSpace.contains(last.value) { scalars.removeLast() }
        return String(scalars)
    }

    // Device names Windows reserves in every folder, with or without an extension (`RESERVED_NAME` on the server).
    private static func isReservedName(_ stem: String) -> Bool {
        let lower = stem.lowercased()
        if ["con", "prn", "aux", "nul", "conin$", "conout$"].contains(lower) { return true }
        guard lower.count == 4, lower.hasPrefix("com") || lower.hasPrefix("lpt"), let last = lower.unicodeScalars.last else { return false }
        return ("0"..."9").contains(last) || ["\u{00B9}", "\u{00B2}", "\u{00B3}"].contains(last)
    }
}
#endif
