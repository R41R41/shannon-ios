import XCTest
@testable import ShannonAppCore

final class ShannonRichMarkdownTests: XCTestCase {
    func testParsesPipeTableWithAlignmentAndPadsShortRows() {
        let blocks = ShannonMessageMarkdown.blocks(from: """
        比べました。
        | 店 | 距離 | 値段 |
        |:---|:---:|---:|
        | A | 300m | 900円 |
        | B |
        続きです。
        """)

        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(blocks.first, .paragraph("比べました。"))
        guard case .table(let table) = blocks[1] else { return XCTFail("table expected") }
        XCTAssertEqual(table.header, ["店", "距離", "値段"])
        XCTAssertEqual(table.alignments, [.leading, .center, .trailing])
        XCTAssertEqual(table.rows, [["A", "300m", "900円"], ["B", "", ""]])
        XCTAssertEqual(blocks.last, .paragraph("続きです。"))
    }

    func testPipeLinesWithoutSeparatorStayText() {
        XCTAssertEqual(ShannonMessageMarkdown.blocks(from: "| a | b |\n| c | d |"), [.paragraph("| a | b |\n| c | d |")])
    }

    func testChartFenceBecomesChartAndInvalidChartStaysCode() {
        let json = #"{"type":"line","title":"気温","x":[2024,2025],"series":[{"name":"東京","values":[16.5,17]}]}"#
        let blocks = ShannonMessageMarkdown.blocks(from: "```chart\n\(json)\n```")
        guard case .chart(let chart) = blocks.first else { return XCTFail("chart expected") }
        XCTAssertEqual(chart.kind, .line)
        XCTAssertEqual(chart.title, "気温")
        XCTAssertEqual(chart.labels, ["2024", "2025"])
        XCTAssertEqual(chart.points.map(\.value), [16.5, 17])

        let mismatched = #"{"type":"bar","x":["A","B"],"series":[{"name":"円","values":[1]}]}"#
        XCTAssertEqual(ShannonMessageMarkdown.blocks(from: "```chart\n\(mismatched)\n```"), [.code(mismatched, language: "chart")])
    }

    func testOnlyStandaloneHTTPSImagesBecomeImages() {
        XCTAssertEqual(ShannonMessageMarkdown.blocks(from: "![駅前](https://example.com/a.jpg)"),
                       [.image(alt: "駅前", url: URL(string: "https://example.com/a.jpg")!)])
        XCTAssertEqual(ShannonMessageMarkdown.blocks(from: "![駅前](http://example.com/a.jpg)"),
                       [.paragraph("![駅前](http://example.com/a.jpg)")])
    }

    func testReactionEmojiFromTypedText() {
        XCTAssertEqual(ShannonReactionsModel.emoji(from: "あ❤️"), "❤️")
        XCTAssertNil(ShannonReactionsModel.emoji(from: "あ"))
        XCTAssertNil(ShannonReactionsModel.emoji(from: "1"))
    }
}
