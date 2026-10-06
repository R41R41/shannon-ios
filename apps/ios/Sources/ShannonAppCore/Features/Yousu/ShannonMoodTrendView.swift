import Charts
import Observation
import OSLog
import SwiftUI

/// 「気分の推移」: her mood over the last hour, 24 hours or 7 days, read from the server's record.
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

/// The section's content: the title with the 1時間／24時間／7日 switch, then one row per line
/// (気分の明るさ／元気さ／心の開き; owner decision 2026-10-06, 「3本を分けて並べる」): the line's name,
/// a small step chart around its resting value with the band of 「ふつう」, and the word for now.
/// The rows share the time axis and the vertical reach; only the bottom row is labelled. No numbers.
struct ShannonMoodTrendPanel: View {
    @Bindable var model: ShannonMoodTrendModel
    let palette: ShannonPalette

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The width of the top row's chart, read only to decide whether 「記録なし」 fits its part.
    @State private var chartWidth: CGFloat = 0

    /// What all three rows share for one answer.
    private struct Frame {
        let start: Date
        let now: Date
        let limit: Double
        let unrecorded: Range<Date>?
        /// Where the band of 「ふつう」 starts: after the part before anything was recorded.
        var recordStart: Date { unrecorded?.upperBound ?? start }
    }

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
                    rows(history)
                } else {
                    quietLine(ShannonGeneratedStrings.yousuMoodTrendEmpty)
                }
            case .unreadable:
                if let history = model.history, history.hasMood {
                    rows(history)
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

    private var hoursSelection: Binding<Int> {
        Binding(get: { model.hours }, set: { hours in Task { await model.choose(hours: hours) } })
    }

    /// Inside the ようす list: on the Mac a segmented choice without an AppKit view (`ShannonSegmentedChoice`).
    @ViewBuilder
    private var rangePicker: some View {
#if os(macOS)
        ShannonSegmentedChoice(ShannonGeneratedStrings.yousuMoodTrendTitle, selection: hoursSelection, options: [
            .init(ShannonGeneratedStrings.yousuMoodTrendRangeHour, value: 1),
            .init(ShannonGeneratedStrings.yousuMoodTrendRangeDay, value: 24),
            .init(ShannonGeneratedStrings.yousuMoodTrendRangeWeek, value: 168),
        ])
#else
        Picker(ShannonGeneratedStrings.yousuMoodTrendTitle, selection: hoursSelection) {
            Text(ShannonGeneratedStrings.yousuMoodTrendRangeHour).tag(1)
            Text(ShannonGeneratedStrings.yousuMoodTrendRangeDay).tag(24)
            Text(ShannonGeneratedStrings.yousuMoodTrendRangeWeek).tag(168)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
#endif
    }

    private func quietLine(_ text: String) -> some View {
        Text(text)
            .font(.shannon(.footnote))
            .foregroundStyle(palette.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
    }

    private var plotHeight: CGFloat { dynamicTypeSize.isAccessibilitySize ? 64 : 40 }

    /// The three rows, read as one element: 「気分の推移」 and the words of now.
    private func rows(_ history: ShannonMoodHistoryDTO) -> some View {
        // The window ends at the server's own time, so a phone whose clock is off draws it right.
        let now = ShannonMoodTrend.windowEnd(history, readAt: model.readAt)
        let start = now.addingTimeInterval(-Double(model.hours) * 3600)
        let frame = Frame(
            start: start, now: now,
            limit: ShannonMoodTrend.yLimit(history.points, carryIn: history.carryIn),
            unrecorded: ShannonMoodTrend.unrecorded(history.points, carryIn: history.carryIn, windowStart: start)
        )
        let levels = ShannonMoodTrend.latestLevels(history.points, carryIn: history.carryIn)
        let lines = ShannonMoodLine.allCases
        return VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            ForEach(Array(lines.enumerated()), id: \.element) { index, line in
                let steps = ShannonMoodTrend.bucketed(
                    ShannonMoodTrend.steps(line, points: history.points, carryIn: history.carryIn, windowStart: start, until: now),
                    windowStart: start, bucket: ShannonMoodTrend.bucket(hours: model.hours)
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.title)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                    HStack(alignment: .top, spacing: ShannonSpacing.small) {
                        rowChart(line, steps: steps, frame: frame, isTop: index == 0, isBottom: index == lines.count - 1)
                        word(line, level: levels?[line])
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ShannonGeneratedStrings.yousuMoodTrendTitle)
        .accessibilityValue(ShannonMoodTrend.summary(history.points, carryIn: history.carryIn) ?? ShannonGeneratedStrings.yousuMoodTrendEmpty)
    }

    /// The word of now, in the line's colour. Every word is laid out unseen behind it, so the
    /// column keeps one width and the three charts stay the same width.
    private func word(_ line: ShannonMoodLine, level: ShannonMoodLevel?) -> some View {
        ZStack(alignment: .leading) {
            ForEach([ShannonMoodLevel.high, .normal, .low], id: \.self) { candidate in
                Text(candidate.word(for: .valence)).hidden()
                Text(candidate.word(for: .arousal)).hidden()
            }
            if let level {
                Text(level.word(for: line)).foregroundStyle(color(line))
            }
        }
        .font(.shannon(.caption).weight(.semibold))
        .lineLimit(1)
        .frame(minHeight: plotHeight)
    }

    private func rowChart(_ line: ShannonMoodLine, steps: [ShannonMoodStep], frame: Frame, isTop: Bool, isBottom: Bool) -> some View {
        let tint = color(line)
        let labelsUnrecorded = isTop && frame.unrecorded.map { part in
            let window = frame.now.timeIntervalSince(frame.start)
            return window > 0 && chartWidth * part.upperBound.timeIntervalSince(part.lowerBound) / window >= 44
        } ?? false
        return Chart {
            // The band of 「ふつう」 (±0.2 from rest), from where the record begins.
            if frame.recordStart < frame.now {
                RectangleMark(
                    xStart: .value("時刻", frame.recordStart), xEnd: .value("時刻", frame.now),
                    yStart: .value("ふつう", -ShannonMoodLevel.threshold), yEnd: .value("ふつう", ShannonMoodLevel.threshold)
                )
                .foregroundStyle(palette.textSecondary.opacity(0.08))
            }
            // Before anything was recorded: shaded, named once in the top row when it is wide enough.
            if let part = frame.unrecorded {
                RectangleMark(
                    xStart: .value("時刻", part.lowerBound), xEnd: .value("時刻", part.upperBound),
                    yStart: .value("記録なし", -frame.limit), yEnd: .value("記録なし", frame.limit)
                )
                .foregroundStyle(palette.textSecondary.opacity(0.12))
                .annotation(position: .overlay, alignment: .center) {
                    if labelsUnrecorded {
                        Text(ShannonGeneratedStrings.yousuMoodTrendUnrecorded)
                            .font(.shannon(.caption2))
                            .foregroundStyle(palette.textSecondary)
                            .lineLimit(1)
                    }
                }
            }
            RuleMark(y: .value("ふつう", 0))
                .foregroundStyle(palette.textSecondary.opacity(0.5))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                AreaMark(x: .value("時刻", step.start), yStart: .value("ふつう", 0), yEnd: .value(line.title, step.value))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(tint.opacity(0.18))
                LineMark(x: .value("時刻", step.start), y: .value(line.title, step.value))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(tint)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
            }
            if let last = steps.last {
                // The value holds until now: the line reaches the right edge, with a dot on now.
                AreaMark(x: .value("時刻", frame.now), yStart: .value("ふつう", 0), yEnd: .value(line.title, last.value))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(tint.opacity(0.18))
                LineMark(x: .value("時刻", frame.now), y: .value(line.title, last.value))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(tint)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                PointMark(x: .value("時刻", frame.now), y: .value(line.title, last.value))
                    .foregroundStyle(tint)
                    .symbolSize(30)
            }
        }
        .chartXScale(domain: frame.start...frame.now)
        .chartYScale(domain: -frame.limit...frame.limit)
        .chartYAxis(.hidden)
        .chartXAxis { xAxis(labelled: isBottom, frame: frame) }
        .chartLegend(.hidden)
        .chartPlotStyle { plot in plot.frame(height: plotHeight) }
        .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.width } action: { width in
            if isTop { chartWidth = width }
        }
    }

    /// Grid lines in every row; times under the bottom row only. 1時間: on the quarter hours
    /// (「20:15」); 24時間: every 6 hours; 7日: by day. A time too near either edge to be read
    /// whole is left unlabelled (its grid line stays).
    @AxisContentBuilder
    private func xAxis(labelled: Bool, frame: Frame) -> some AxisContent {
        let japanese = Locale(identifier: "ja_JP")
        if model.hours <= 1 {
            AxisMarks(values: ShannonMoodTrend.quarterHours(from: frame.start, to: frame.now)) { value in
                xMark(value, labelled: labelled, frame: frame, format: .dateTime.hour().minute().locale(japanese))
            }
        } else if model.hours <= 24 {
            AxisMarks(values: .stride(by: .hour, count: 6)) { value in
                xMark(value, labelled: labelled, frame: frame, format: .dateTime.hour().locale(japanese))
            }
        } else {
            AxisMarks(values: .stride(by: .day)) { value in
                xMark(value, labelled: labelled, frame: frame, format: .dateTime.day().locale(japanese))
            }
        }
    }

    @AxisMarkBuilder
    private func xMark(_ value: AxisValue, labelled: Bool, frame: Frame, format: Date.FormatStyle) -> some AxisMark {
        let margin = frame.now.timeIntervalSince(frame.start) * 0.06
        AxisGridLine().foregroundStyle(palette.divider.opacity(0.5))
        if labelled, let date = value.as(Date.self),
           date.timeIntervalSince(frame.start) >= margin, frame.now.timeIntervalSince(date) >= margin {
            AxisValueLabel(format: format)
        }
    }

    private func color(_ line: ShannonMoodLine) -> Color {
        switch line {
        case .valence: palette.action
        case .arousal: palette.attention
        case .openness: palette.success
        }
    }
}
