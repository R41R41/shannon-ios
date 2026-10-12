import Foundation

/// A GFM pipe table: a header row, a `|---|` separator row (with optional `:` alignment) and body rows.
/// Cells keep their inline Markdown; rows are padded or cut to the header's width.
public struct ShannonMarkdownTable: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case leading, center, trailing }

    public static let maximumColumns = 8
    public static let maximumRows = 50

    public let header: [String]
    public let alignments: [Alignment]
    public let rows: [[String]]

    public init?(lines: [String]) {
        guard lines.count >= 2 else { return nil }
        let header = Self.cells(of: lines[0])
        let separator = Self.cells(of: lines[1])
        guard !header.isEmpty, header.count <= Self.maximumColumns, separator.count == header.count,
              let alignments = Self.alignments(of: separator)
        else { return nil }
        self.header = header
        self.alignments = alignments
        self.rows = lines.dropFirst(2).prefix(Self.maximumRows).map { line in
            let cells = Self.cells(of: line)
            return (0..<header.count).map { $0 < cells.count ? cells[$0] : "" }
        }
    }

    public func alignment(at column: Int) -> Alignment {
        column < alignments.count ? alignments[column] : .leading
    }

    /// `| a | b |` → `["a", "b"]`; an escaped `\|` stays inside its cell.
    static func cells(of line: String) -> [String] {
        let placeholder = "\u{F8FF}"
        var trimmed = line.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\\|", with: placeholder)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.components(separatedBy: "|").map {
            $0.replacingOccurrences(of: placeholder, with: "|").trimmingCharacters(in: .whitespaces)
        }
    }

    static func alignments(of separator: [String]) -> [Alignment]? {
        var result: [Alignment] = []
        for cell in separator {
            let leftColon = cell.hasPrefix(":"), rightColon = cell.hasSuffix(":")
            let dashes = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            result.append(leftColon && rightColon ? .center : rightColon ? .trailing : .leading)
        }
        return result
    }
}

/// A small chart the reply describes in a ```` ```chart ```` fence:
/// `{"type":"bar"|"line","title":"…","x":["…"],"series":[{"name":"…","values":[1,2]}]}`. Anything else stays a code block.
public struct ShannonChartSpec: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable { case bar, line }
    public struct Series: Equatable, Sendable {
        public let name: String
        public let values: [Double]
    }
    public struct Point: Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let value: Double
        public let series: String
    }

    public static let maximumLabels = 24
    public static let maximumSeries = 4

    public let kind: Kind
    public let title: String?
    public let labels: [String]
    public let series: [Series]

    public init?(json: String) {
        guard let data = json.data(using: .utf8),
              let raw = try? JSONDecoder().decode(Raw.self, from: data),
              let kind = Kind(rawValue: raw.type.lowercased()),
              (1...Self.maximumLabels).contains(raw.x.count),
              (1...Self.maximumSeries).contains(raw.series.count),
              raw.series.allSatisfy({ $0.values.count == raw.x.count && $0.values.allSatisfy(\.isFinite) })
        else { return nil }
        self.kind = kind
        let title = raw.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = title?.isEmpty == false ? String(title!.prefix(80)) : nil
        self.labels = raw.x.map { String($0.text.prefix(24)) }
        self.series = raw.series.enumerated().map { index, item in
            let name = item.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return Series(name: name.isEmpty ? "系列\(index + 1)" : String(name.prefix(24)), values: item.values)
        }
    }

    /// Every value as a mark, in label order.
    public var points: [Point] {
        series.enumerated().flatMap { seriesIndex, item in
            item.values.enumerated().map { index, value in
                Point(id: "\(seriesIndex)-\(index)", label: labels[index], value: value, series: item.name)
            }
        }
    }

    private struct Raw: Decodable {
        let type: String
        let title: String?
        let x: [Label]
        let series: [RawSeries]
    }
    private struct RawSeries: Decodable {
        let name: String?
        let values: [Double]
    }
    /// A label written as text or as a number (a year, a month).
    private struct Label: Decodable {
        let text: String
        init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self) {
                self.text = text
            } else {
                let number = try container.decode(Double.self)
                self.text = number.rounded() == number && abs(number) < 1e15 ? String(Int64(number)) : String(number)
            }
        }
    }
}

extension ShannonMessageMarkdown {
    private static let imageExpression = try! NSRegularExpression(pattern: #"^!\[([^\]]*)\]\((https://[^\s)]+)\)$"#)

    /// A line that is only `![alt](https://…)` with a host; any other scheme stays text.
    static func imageBlock(from line: String) -> Block? {
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = imageExpression.firstMatch(in: line, range: range),
              let altRange = Range(match.range(at: 1), in: line),
              let urlRange = Range(match.range(at: 2), in: line),
              let url = URL(string: String(line[urlRange])), url.scheme == "https", !(url.host ?? "").isEmpty
        else { return nil }
        return .image(alt: String(line[altRange]), url: url)
    }
}
