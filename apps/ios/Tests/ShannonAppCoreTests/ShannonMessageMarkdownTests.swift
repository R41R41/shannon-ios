import XCTest
@testable import ShannonAppCore

final class ShannonMessageMarkdownTests: XCTestCase {
    func testPreservesMarkdownLinkWithHTTPSDestination() {
        let text = ShannonMessageMarkdown.render("詳しくは [OpenAI Docs](https://openai.com/docs) を見てください")

        XCTAssertEqual(String(text.characters), "詳しくは OpenAI Docs を見てください")
        XCTAssertEqual(link(in: "OpenAI Docs", text: text)?.absoluteString, "https://openai.com/docs")
    }

    func testAddsLinkToBareHTTPSURLWithoutChangingVisibleText() {
        let source = "資料は https://example.com/guide?lang=ja です。"
        let text = ShannonMessageMarkdown.render(source)

        XCTAssertEqual(String(text.characters), source)
        XCTAssertEqual(link(in: "https://example.com/guide?lang=ja", text: text)?.absoluteString, "https://example.com/guide?lang=ja")
        XCTAssertNil(link(in: "。", text: text))
    }

    func testAddsLinkForBareWWWURL() {
        let text = ShannonMessageMarkdown.render("www.example.com を開く")

        XCTAssertEqual(link(in: "www.example.com", text: text)?.absoluteString, "http://www.example.com")
    }

    func testRejectsUnsafeAndNonWebMarkdownDestinations() {
        let text = ShannonMessageMarkdown.render("[危険](javascript:alert(1)) と [ローカル](file:///tmp/secret)")

        XCTAssertEqual(String(text.characters), "危険 と ローカル")
        XCTAssertNil(link(in: "危険", text: text))
        XCTAssertNil(link(in: "ローカル", text: text))
    }

    func testDoesNotTurnURLsInInlineCodeIntoLinks() {
        let text = ShannonMessageMarkdown.render("`https://example.com/token` を実行しない")

        XCTAssertEqual(String(text.characters), "https://example.com/token を実行しない")
        XCTAssertNil(link(in: "https://example.com/token", text: text))
    }

    func testPreservesNonLinkMarkdownFormatting() {
        let text = ShannonMessageMarkdown.render("**大事** と `code`")

        XCTAssertEqual(String(text.characters), "大事 と code")
        XCTAssertTrue(hasIntent(.stronglyEmphasized, in: "大事", text: text))
        XCTAssertTrue(hasIntent(.code, in: "code", text: text))
    }

    private func link(in string: String, text: AttributedString) -> URL? {
        guard let range = String(text.characters).range(of: string),
              let attributedRange = attributedRange(for: range, in: text)
        else { return nil }
        return text[attributedRange].link
    }

    private func hasIntent(
        _ intent: InlinePresentationIntent,
        in string: String,
        text: AttributedString
    ) -> Bool {
        guard let range = String(text.characters).range(of: string),
              let attributedRange = attributedRange(for: range, in: text)
        else { return false }
        return text.runs.contains {
            $0.range.lowerBound <= attributedRange.lowerBound
                && $0.range.upperBound >= attributedRange.upperBound
                && $0.inlinePresentationIntent?.contains(intent) == true
        }
    }

    private func attributedRange(
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
}
