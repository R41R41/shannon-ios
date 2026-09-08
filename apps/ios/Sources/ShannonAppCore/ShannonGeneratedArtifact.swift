import Foundation

public enum ShannonGeneratedArtifact {
    public static let maximumContentCharacters = 12_000

    public static func safeFilename(_ candidate: String, mimeType: String) -> String {
        let trimmed = candidate.precomposedStringWithCanonicalMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let forbidden = CharacterSet.controlCharacters
            .union(CharacterSet(charactersIn: "/\\:"))
        let pieces = trimmed.components(separatedBy: forbidden).filter { !$0.isEmpty }
        var name = pieces.joined(separator: "-")
        if name == "." || name == ".." || name.isEmpty {
            name = "shannon-artifact"
        }
        name = String(name.prefix(120))
        if URL(fileURLWithPath: name).pathExtension.isEmpty {
            name += "." + preferredExtension(for: mimeType)
        }
        return name
    }

    public static func preferredExtension(for mimeType: String) -> String {
        switch mimeType {
        case "text/markdown": "md"
        case "application/json": "json"
        case "text/csv": "csv"
        case "text/x-source-code": "txt"
        default: "txt"
        }
    }

    public static func isMarkdown(_ artifact: ShannonGeneratedArtifactDTO) -> Bool {
        artifact.mimeType == "text/markdown"
            || artifact.name.lowercased().hasSuffix(".md")
            || artifact.name.lowercased().hasSuffix(".markdown")
    }
}
