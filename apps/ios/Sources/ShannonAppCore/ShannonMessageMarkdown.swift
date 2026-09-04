import Foundation

/// Produces the rich text used for messages written by either speaker.
///
/// Markdown links and bare web addresses are intentionally limited to HTTP(S).
/// This keeps message content from invoking custom URL schemes when SwiftUI opens
/// a link, while still allowing ordinary external web pages to be opened.
enum ShannonMessageMarkdown {
    private static let bareURLExpression = try! NSRegularExpression(
        pattern: #"(?:https?://|www\.)[^\s<>()\[\]{}]+"#,
        options: [.caseInsensitive]
    )

    static func render(_ source: String) -> AttributedString {
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
}
