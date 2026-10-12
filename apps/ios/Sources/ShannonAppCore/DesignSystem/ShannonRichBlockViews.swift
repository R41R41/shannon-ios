import Charts
import SwiftUI

/// The rich blocks of a message (rich chat, owner decision 2026-10-13): a table, a chart or an image. Every other block is
/// drawn by the message view itself. Shared by the iPhone (`ShannonRichMarkdownText`) and the Mac (`DesktopMarkdownView`).
public struct ShannonRichBlockView: View {
    let block: ShannonMessageMarkdown.Block

    public init(block: ShannonMessageMarkdown.Block) {
        self.block = block
    }

    public var body: some View {
        switch block {
        case .table(let table):
            ShannonMarkdownTableView(table: table)
        case .chart(let chart):
            ShannonMarkdownChartView(chart: chart)
        case .image(let alt, let url):
            ShannonMarkdownImageView(alt: alt, url: url)
        default:
            EmptyView()
        }
    }
}

/// A table that scrolls sideways when it is wider than the message.
struct ShannonMarkdownTableView: View {
    let table: ShannonMarkdownTable
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: ShannonSpacing.large, verticalSpacing: ShannonSpacing.small) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
                        cellText(cell, column: column)
                            .font(.shannon(.footnote).weight(.semibold))
                            .foregroundStyle(palette.textPrimary)
                    }
                }
                Divider()
                    .overlay(palette.divider)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            cellText(cell, column: column)
                                .font(.shannon(.footnote).monospacedDigit())
                                .foregroundStyle(palette.textPrimary)
                        }
                    }
                }
            }
            .padding(ShannonSpacing.medium)
        }
        .scrollIndicators(.hidden)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("表、\(table.rows.count)行")
    }

    private func cellText(_ cell: String, column: Int) -> some View {
        Text(ShannonMessageMarkdown.render(cell))
            .lineLimit(4)
            .multilineTextAlignment(textAlignment(table.alignment(at: column)))
            .frame(maxWidth: 260, alignment: frameAlignment(table.alignment(at: column)))
            .gridColumnAlignment(columnAlignment(table.alignment(at: column)))
    }

    private func columnAlignment(_ alignment: ShannonMarkdownTable.Alignment) -> HorizontalAlignment {
        switch alignment {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private func frameAlignment(_ alignment: ShannonMarkdownTable.Alignment) -> Alignment {
        switch alignment {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private func textAlignment(_ alignment: ShannonMarkdownTable.Alignment) -> TextAlignment {
        switch alignment {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

/// A bar or line chart (Swift Charts) from the reply's ```` ```chart ```` spec.
struct ShannonMarkdownChartView: View {
    let chart: ShannonChartSpec
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            if let title = chart.title {
                Text(title)
                    .font(.shannon(.subheadline).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
            }
            Group {
                if chart.kind == .bar {
                    Chart(chart.points) { point in
                        BarMark(x: .value("項目", point.label), y: .value("値", point.value))
                            .foregroundStyle(by: .value("系列", point.series))
                            .position(by: .value("系列", point.series))
                    }
                } else {
                    Chart(chart.points) { point in
                        LineMark(x: .value("項目", point.label), y: .value("値", point.value))
                            .foregroundStyle(by: .value("系列", point.series))
                        PointMark(x: .value("項目", point.label), y: .value("値", point.value))
                            .foregroundStyle(by: .value("系列", point.series))
                    }
                }
            }
            .chartLegend(chart.series.count > 1 ? .visible : .hidden)
            .frame(height: 200)
        }
        .padding(ShannonSpacing.medium)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        let lines = chart.series.map { item in
            "\(item.name): " + zip(chart.labels, item.values).map { "\($0) \($1.formatted())" }.joined(separator: "、")
        }
        return ([chart.title ?? "グラフ"] + lines).joined(separator: "。")
    }
}

/// An HTTPS image, its size capped; tapping it opens the address.
struct ShannonMarkdownImageView: View {
    let alt: String
    let url: URL
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Button {
            openURL(url)
        } label: {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image
                        .resizable()
                        .scaledToFit()
                } else if phase.error != nil {
                    Label(alt.isEmpty ? "画像を読み込めませんでした" : alt, systemImage: "photo")
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                        .frame(maxWidth: .infinity, minHeight: 56)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 120)
                }
            }
            .frame(maxWidth: 360, maxHeight: 260, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(alt.isEmpty ? "画像" : alt)
        .accessibilityHint("開くと元の画像を表示します")
    }
}
