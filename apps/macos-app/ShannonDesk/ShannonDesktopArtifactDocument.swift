import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

struct ShannonArtifactDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText, .data] }

    let content: String

    init(content: String) {
        self.content = content
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        content = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(content.utf8))
    }
}

extension ShannonGeneratedArtifactDTO {
    var exportContentType: UTType {
        switch mimeType {
        case "text/markdown": .init(filenameExtension: "md") ?? .plainText
        case "application/json": .json
        case "text/csv": .commaSeparatedText
        default: .plainText
        }
    }
}
