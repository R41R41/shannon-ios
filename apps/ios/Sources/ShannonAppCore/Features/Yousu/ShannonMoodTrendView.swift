import Charts
import Observation
import SwiftUI

/// 「気分の推移」: her mood over the last 24 hours or 7 days, read from the server's record.
/// When the server does not offer it to this device (403, 404) or cannot be reached, the
/// section is not shown: the iPhone and the Mac keep no record of their own.
@MainActor
@Observable
public final class ShannonMoodTrendModel {
    public private(set) var history: ShannonMoodHistoryDTO?
    /// False after a read that was refused or failed: the section is left out.
    public private(set) var isAvailable = true
    public private(set) var hours = 24
    public private(set) var readAt = Date()

    private let scopeKey: String
    private let client: (any ShannonYousuServing)?

    public init(scopeKey: String = "local-owner", client: (any ShannonYousuServing)?) {
        self.scopeKey = scopeKey
        self.client = client
    }

    public func choose(hours: Int) async {
        guard hours != self.hours else { return }
        self.hours = hours
        history = nil
        await reload()
    }

    public func reload() async {
        guard let client else { isAvailable = false; return }
        let (scopeKey, hours) = (scopeKey, hours)
        do {
            let answer = try await client.loadShannonMoodHistory(scopeKey: scopeKey, hours: hours)
            guard hours == self.hours else { return }
            history = answer
            readAt = Date()
            isAvailable = true
        } catch where ShannonOpsModel.isCancellation(error) {
            return
        } catch {
            guard hours == self.hours else { return }
            history = nil
            isAvailable = false
        }
    }
}

/// The section's content: the title with the 24時間／7日 switch, three step lines (solid, long
/// dash, dotted, so that colour is never the only difference), and the legend. No numbers.
struct ShannonMoodTrendPanel: View {
    @Bindable var model: ShannonMoodTrendModel
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            HStack(alignment: .firstTextBaseline) {
                Text(ShannonGeneratedStrings.yousuMoodTrendTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: ShannonSpacing.small)
                Picker(ShannonGeneratedStrings.yousuMoodTrendTitle, selection: Binding(
                    get: { model.hours },
                    set: { hours in Task { await model.choose(hours: hours) } }
                )) {
                    Text(ShannonGeneratedStrings.yousuMoodTrendRangeDay).tag(24)
                    Text(ShannonGeneratedStrings.yousuMoodTrendRangeWeek).tag(168)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            if let points = model.history?.points, !points.isEmpty {
                chart(points)
                legend
            } else if model.history != nil {
                Text(ShannonGeneratedStrings.yousuMoodTrendEmpty)
                    .font(.footnote)
                    .foregroundStyle(palette.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 60)
            }
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
    }

    private func chart(_ points: [ShannonMoodHistoryDTO.Point]) -> some View {
        let now = model.readAt
        let start = now.addingTimeInterval(-Double(model.hours) * 3600)
        return Chart {
            RuleMark(y: .value("ふつう", 0))
                .foregroundStyle(palette.divider)
                .lineStyle(StrokeStyle(lineWidth: 1))
            ForEach(ShannonMoodLine.allCases) { line in
                let steps = ShannonMoodTrend.steps(line, points: points, until: now)
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    LineMark(x: .value("時刻", max(step.start, start)), y: .value(line.title, step.value), series: .value("線", line.rawValue))
                        .interpolationMethod(.stepEnd)
                        .foregroundStyle(color(line))
                        .lineStyle(stroke(line))
                }
                if let last = steps.last {
                    // The value holds until now: the line reaches the right edge.
                    LineMark(x: .value("時刻", now), y: .value(line.title, last.value), series: .value("線", line.rawValue))
                        .interpolationMethod(.stepEnd)
                        .foregroundStyle(color(line))
                        .lineStyle(stroke(line))
                    PointMark(x: .value("時刻", max(last.start, start)), y: .value(line.title, last.value))
                        .foregroundStyle(color(line))
                        .symbolSize(36)
                }
            }
        }
        .chartXScale(domain: start...now)
        .chartYScale(domain: -1...1)
        .chartYAxis(.hidden)
        .chartXAxis {
            if model.hours > 24 {
                AxisMarks(values: .stride(by: .day)) { _ in
                    AxisGridLine().foregroundStyle(palette.divider.opacity(0.5))
                    AxisValueLabel(format: .dateTime.day().locale(Locale(identifier: "ja_JP")))
                }
            } else {
                AxisMarks(values: .stride(by: .hour, count: 6)) { _ in
                    AxisGridLine().foregroundStyle(palette.divider.opacity(0.5))
                    AxisValueLabel(format: .dateTime.hour().locale(Locale(identifier: "ja_JP")))
                }
            }
        }
        .chartLegend(.hidden)
        .frame(height: 100)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ShannonGeneratedStrings.yousuMoodTrendTitle)
        .accessibilityValue(ShannonMoodTrend.summary(points) ?? ShannonGeneratedStrings.yousuMoodTrendEmpty)
    }

    private var legend: some View {
        HStack(spacing: ShannonSpacing.medium) {
            ForEach(ShannonMoodLine.allCases) { line in
                HStack(spacing: ShannonSpacing.extraSmall) {
                    Path { path in
                        path.move(to: CGPoint(x: 0, y: 4))
                        path.addLine(to: CGPoint(x: 20, y: 4))
                    }
                    .stroke(color(line), style: stroke(line))
                    .frame(width: 20, height: 8)
                    Text(line.title)
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func color(_ line: ShannonMoodLine) -> Color {
        switch line {
        case .valence: palette.action
        case .arousal: palette.attention
        case .openness: palette.success
        }
    }

    private func stroke(_ line: ShannonMoodLine) -> StrokeStyle {
        switch line {
        case .valence: StrokeStyle(lineWidth: 2, lineCap: .round)
        case .arousal: StrokeStyle(lineWidth: 2, lineCap: .butt, dash: [8, 4])
        case .openness: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.5, 4])
        }
    }
}
