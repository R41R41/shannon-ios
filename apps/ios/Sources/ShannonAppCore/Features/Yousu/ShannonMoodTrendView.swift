import Charts
import Observation
import OSLog
import SwiftUI

/// 「気分の推移」: her mood over the last 24 hours or 7 days, read from the server's record.
/// Hidden until the first answer, and when the server does not offer it to this device (403,
/// 404): the iPhone and the Mac keep no record of their own. Any other failure keeps the
/// section with a quiet 「読めませんでした」, and the next appearance reads again.
@MainActor
@Observable
public final class ShannonMoodTrendModel {
    public enum Phase: Equatable, Sendable {
        /// Not answered yet, or not offered to this device: the section is not shown.
        case hidden
        /// Shown, reading (after the switch changed).
        case loading
        case loaded
        /// Shown, but the last read failed. The last good answer of the same window, if any, is kept.
        case unreadable
    }

    public private(set) var phase: Phase = .hidden
    public private(set) var history: ShannonMoodHistoryDTO?
    public private(set) var hours = 24
    public private(set) var readAt = Date()

    public var isAvailable: Bool { phase != .hidden }

    private let scopeKey: String
    private let client: (any ShannonYousuServing)?
    private static let logger = Logger(subsystem: "com.r41r41.shannon", category: "MoodTrend")

    public init(scopeKey: String = "local-owner", client: (any ShannonYousuServing)?) {
        self.scopeKey = scopeKey
        self.client = client
    }

    public func choose(hours: Int) async {
        guard hours != self.hours else { return }
        self.hours = hours
        history = nil
        if phase != .hidden { phase = .loading }
        await reload()
    }

    public func reload() async {
        guard let client else { phase = .hidden; return }
        let (scopeKey, hours) = (scopeKey, hours)
        do {
            let answer = try await client.loadShannonMoodHistory(scopeKey: scopeKey, hours: hours)
            guard hours == self.hours else { return }
            history = answer
            readAt = Date()
            phase = .loaded
        } catch where ShannonOpsModel.isCancellation(error) {
            return
        } catch let error as ShannonAPIError where error == .rejected(status: 403) || error == .rejected(status: 404) {
            guard hours == self.hours else { return }
            history = nil
            phase = .hidden
        } catch {
            guard hours == self.hours else { return }
            if error is DecodingError {
                Self.logger.error("Mood history could not be decoded: \(String(describing: error), privacy: .public)")
            }
            // The last good chart of this window stays; a note under it says this read failed.
            phase = .unreadable
        }
    }
}

/// The section's content: the title with the 24時間／7日 switch, three step lines (solid, long
/// dash, dotted, so that colour is never the only difference), and the legend. No numbers.
struct ShannonMoodTrendPanel: View {
    @Bindable var model: ShannonMoodTrendModel
    let palette: ShannonPalette

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    title
                    Spacer(minLength: ShannonSpacing.small)
                    rangePicker
                }
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    title
                    rangePicker
                }
            }
            switch model.phase {
            case .loaded:
                if let history = model.history, history.hasMood {
                    chart(history)
                    legend
                } else {
                    quietLine(ShannonGeneratedStrings.yousuMoodTrendEmpty)
                }
            case .unreadable:
                if let history = model.history, history.hasMood {
                    chart(history)
                    legend
                    Text(ShannonGeneratedStrings.yousuMoodTrendUnreadable)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                } else {
                    quietLine(ShannonGeneratedStrings.yousuMoodTrendUnreadable)
                }
            case .loading, .hidden:
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 60)
            }
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
    }

    private var title: some View {
        Text(ShannonGeneratedStrings.yousuMoodTrendTitle)
            .font(.shannon(.subheadline).weight(.semibold))
            .foregroundStyle(palette.textPrimary)
            .accessibilityAddTraits(.isHeader)
    }

    private var rangePicker: some View {
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

    private func quietLine(_ text: String) -> some View {
        Text(text)
            .font(.shannon(.footnote))
            .foregroundStyle(palette.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
    }

    private func chart(_ history: ShannonMoodHistoryDTO) -> some View {
        // The window ends at the server's own time, so a phone whose clock is off draws it right.
        let now = ShannonMoodTrend.windowEnd(history, readAt: model.readAt)
        let start = now.addingTimeInterval(-Double(model.hours) * 3600)
        return Chart {
            RuleMark(y: .value("ふつう", 0))
                .foregroundStyle(palette.divider)
                .lineStyle(StrokeStyle(lineWidth: 1))
            ForEach(ShannonMoodLine.allCases) { line in
                let steps = ShannonMoodTrend.steps(line, points: history.points, carryIn: history.carryIn, windowStart: start, until: now)
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
                    // The newest point; with only the value carried in from before the window, its value now, at the right edge.
                    PointMark(x: .value("時刻", history.points.isEmpty ? now : max(last.start, start)), y: .value(line.title, last.value))
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
        .frame(height: dynamicTypeSize.isAccessibilitySize ? 140 : 100)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ShannonGeneratedStrings.yousuMoodTrendTitle)
        .accessibilityValue(ShannonMoodTrend.summary(history.points, carryIn: history.carryIn) ?? ShannonGeneratedStrings.yousuMoodTrendEmpty)
    }

    /// One row of three; one line each at the larger text sizes.
    private var legend: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: ShannonSpacing.medium) { legendItems }
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) { legendItems }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var legendItems: some View {
        ForEach(ShannonMoodLine.allCases) { line in
            HStack(spacing: ShannonSpacing.extraSmall) {
                Path { path in
                    path.move(to: CGPoint(x: 0, y: 4))
                    path.addLine(to: CGPoint(x: 20, y: 4))
                }
                .stroke(color(line), style: stroke(line))
                .frame(width: 20, height: 8)
                Text(line.title)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize()
            }
        }
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
