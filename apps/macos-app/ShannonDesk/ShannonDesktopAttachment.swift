import Foundation
import ShannonAppCore

enum ShannonDesktopAttachmentLimits {
    static let maximumCount = 4
    static let maximumBytesPerFile = 24_000
    static let maximumTotalBytes = 48_000
}

enum ShannonDesktopAttachmentError: LocalizedError, Equatable {
    case tooManyFiles
    case duplicateName(String)
    case unsupportedType(String)
    case notARegularFile(String)
    case fileTooLarge(String)
    case totalTooLarge
    case unreadable(String)

    var errorDescription: String? {
        switch self {
        case .tooManyFiles:
            "添付できるファイルは4件までです。"
        case .duplicateName(let name):
            "同じ名前のファイル「\(name)」は追加できません。"
        case .unsupportedType(let name):
            "「\(name)」はまだ添付できません。テキスト、Markdown、コード、CSV、JSONを選んでください。"
        case .notARegularFile(let name):
            "「\(name)」は通常のファイルではありません。"
        case .fileTooLarge(let name):
            "「\(name)」は24KBを超えています。必要な部分だけに分けてください。"
        case .totalTooLarge:
            "添付の合計は48KBまでです。"
        case .unreadable(let name):
            "「\(name)」をUTF-8のテキストとして読めませんでした。"
        }
    }
}

struct ShannonDesktopAttachmentLoader {
    static func load(
        urls: [URL],
        existing: [ShannonChatAttachmentDTO] = []
    ) throws -> [ShannonChatAttachmentDTO] {
        guard existing.count + urls.count <= ShannonDesktopAttachmentLimits.maximumCount else {
            throw ShannonDesktopAttachmentError.tooManyFiles
        }

        var names = Set(existing.map(\.name))
        var totalBytes = existing.reduce(0) { $0 + $1.text.utf8.count }
        var result = existing

        for url in urls {
            let name = url.lastPathComponent
            guard !name.isEmpty else { throw ShannonDesktopAttachmentError.unreadable("ファイル") }
            guard names.insert(name).inserted else {
                throw ShannonDesktopAttachmentError.duplicateName(name)
            }
            guard let mimeType = mimeType(for: url.pathExtension) else {
                throw ShannonDesktopAttachmentError.unsupportedType(name)
            }

            let accessed = url.startAccessingSecurityScopedResource()
            defer {
                if accessed { url.stopAccessingSecurityScopedResource() }
            }

            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            if values?.isRegularFile == false {
                throw ShannonDesktopAttachmentError.notARegularFile(name)
            }
            if let size = values?.fileSize, size > ShannonDesktopAttachmentLimits.maximumBytesPerFile {
                throw ShannonDesktopAttachmentError.fileTooLarge(name)
            }

            guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
                  data.count <= ShannonDesktopAttachmentLimits.maximumBytesPerFile,
                  let text = String(data: data, encoding: .utf8),
                  !text.contains("\0")
            else {
                if let size = values?.fileSize,
                   size > ShannonDesktopAttachmentLimits.maximumBytesPerFile {
                    throw ShannonDesktopAttachmentError.fileTooLarge(name)
                }
                throw ShannonDesktopAttachmentError.unreadable(name)
            }

            totalBytes += data.count
            guard totalBytes <= ShannonDesktopAttachmentLimits.maximumTotalBytes else {
                throw ShannonDesktopAttachmentError.totalTooLarge
            }
            result.append(.init(name: name, mimeType: mimeType, text: text))
        }
        return result
    }

    private static func mimeType(for pathExtension: String) -> String? {
        switch pathExtension.lowercased() {
        case "txt", "log": "text/plain"
        case "md", "markdown": "text/markdown"
        case "csv": "text/csv"
        case "json": "application/json"
        case "xml": "application/xml"
        case "html", "htm": "text/html"
        case "css": "text/css"
        case "swift": "text/x-swift"
        case "js", "mjs", "cjs": "text/javascript"
        case "ts", "tsx": "text/typescript"
        case "jsx": "text/jsx"
        case "py": "text/x-python"
        case "rb": "text/x-ruby"
        case "sh", "zsh", "bash": "text/x-shellscript"
        case "yml", "yaml": "application/yaml"
        case "sql": "application/sql"
        case "c", "h", "cc", "cpp", "hpp", "go", "rs", "kt", "java": "text/plain"
        default: nil
        }
    }
}
