import Foundation

/// Produces the rich text used for messages written by either speaker.
///
/// Markdown links and bare web addresses are intentionally limited to HTTP(S).
/// This keeps message content from invoking custom URL schemes when SwiftUI opens
/// a link, while still allowing ordinary external web pages to be opened.
public enum ShannonMessageMarkdown {
    public enum Block: Equatable {
        case heading(level: Int, text: String)
        case bullet(String)
        case numbered(marker: String, text: String)
        case quote(String)
        case code(String)
        case divider
        case paragraph(String)
    }

    private static let bareURLExpression = try! NSRegularExpression(
        pattern: #"(?:https?://|www\.)[^\s<>()\[\]{}]+"#,
        options: [.caseInsensitive]
    )

    public static func render(_ source: String) -> AttributedString {
        var text = (try? AttributedString(
            markdown: source,
            options: .init(
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        )) ?? AttributedString(source)

        // Remember every Markdown-link range before removing unsafe destinations.
        // A URL-looking label for an unsafe Markdown link must not be re-added as
        // a bare URL below.
        let markdownLinkRanges = text.runs.compactMap { run in
            run.link == nil ? nil : run.range
        }

        for run in text.runs {
            guard let url = run.link, !isWebURL(url) else { continue }
            text[run.range].link = nil
        }

        let rendered = String(text.characters)
        let searchRange = NSRange(rendered.startIndex..<rendered.endIndex, in: rendered)

        for match in bareURLExpression.matches(in: rendered, range: searchRange).reversed() {
            guard
                let stringRange = Range(match.range, in: rendered),
                let attributedRange = attributedRange(for: stringRange, in: text),
                !markdownLinkRanges.contains(where: { overlaps($0, attributedRange) }),
                !containsCode(in: attributedRange, text: text)
            else {
                continue
            }

            let candidate = String(rendered[stringRange])
            guard let url = webURL(fromBareURL: candidate) else { continue }
            text[attributedRange].link = url
        }

        return text
    }

    public static func blocks(from source: String) -> [Block] {
        var result: [Block] = []
        var paragraphLines: [String] = []
        var codeLines: [String] = []
        var insideCode = false

        func flushParagraph() {
            guard !paragraphLines.isEmpty else { return }
            result.append(.paragraph(paragraphLines.joined(separator: "\n")))
            paragraphLines.removeAll(keepingCapacity: true)
        }

        func flushCode() {
            result.append(.code(codeLines.joined(separator: "\n")))
            codeLines.removeAll(keepingCapacity: true)
        }

        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n")
        for rawLine in normalized.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)

            if line.hasPrefix("```") {
                flushParagraph()
                if insideCode { flushCode() }
                insideCode.toggle()
                continue
            }
            if insideCode {
                codeLines.append(rawLine)
                continue
            }
            if line.isEmpty {
                flushParagraph()
                continue
            }
            if ["---", "***", "___"].contains(line) {
                flushParagraph()
                result.append(.divider)
                continue
            }

            let headingLevel = line.prefix { $0 == "#" }.count
            if (1...6).contains(headingLevel), line.dropFirst(headingLevel).hasPrefix(" ") {
                flushParagraph()
                result.append(.heading(
                    level: headingLevel,
                    text: String(line.dropFirst(headingLevel + 1))
                ))
                continue
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
                flushParagraph()
                result.append(.bullet(String(line.dropFirst(2))))
                continue
            }
            if line.hasPrefix("> ") {
                flushParagraph()
                result.append(.quote(String(line.dropFirst(2))))
                continue
            }
            if let numbered = numberedListItem(from: line) {
                flushParagraph()
                result.append(.numbered(marker: numbered.marker, text: numbered.text))
                continue
            }
            paragraphLines.append(line)
        }

        flushParagraph()
        if insideCode || !codeLines.isEmpty { flushCode() }
        return result
    }

    private static func attributedRange(
        for stringRange: Range<String.Index>,
        in text: AttributedString
    ) -> Range<AttributedString.Index>? {
        let rendered = String(text.characters)
        let startOffset = rendered.distance(from: rendered.startIndex, to: stringRange.lowerBound)
        let endOffset = rendered.distance(from: rendered.startIndex, to: stringRange.upperBound)
        let start = text.index(text.startIndex, offsetByCharacters: startOffset)
        let end = text.index(text.startIndex, offsetByCharacters: endOffset)
        return start..<end
    }

    private static func containsCode(in range: Range<AttributedString.Index>, text: AttributedString) -> Bool {
        text.runs.contains { run in
            overlaps(run.range, range) && run.inlinePresentationIntent?.contains(.code) == true
        }
    }

    private static func overlaps(
        _ lhs: Range<AttributedString.Index>,
        _ rhs: Range<AttributedString.Index>
    ) -> Bool {
        lhs.lowerBound < rhs.upperBound && rhs.lowerBound < lhs.upperBound
    }

    private static func webURL(fromBareURL candidate: String) -> URL? {
        let trimmed = candidate.trimmingCharacters(in: .punctuationCharacters)
        let value = trimmed.lowercased().hasPrefix("www.") ? "https://\(trimmed)" : trimmed
        guard let url = URL(string: value), isWebURL(url) else { return nil }
        return url
    }

    private static func isWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else {
            return false
        }
        return !(url.host?.isEmpty ?? true)
    }

    private static func numberedListItem(from line: String) -> (marker: String, text: String)? {
        guard let separator = line.firstIndex(of: "."),
              !line[..<separator].isEmpty,
              line[..<separator].allSatisfy(\.isNumber)
        else { return nil }
        let textStart = line.index(after: separator)
        guard textStart < line.endIndex, line[textStart] == " " else { return nil }
        let valueStart = line.index(after: textStart)
        guard valueStart <= line.endIndex else { return nil }
        return (String(line[...separator]), String(line[valueStart...]))
    }
}
