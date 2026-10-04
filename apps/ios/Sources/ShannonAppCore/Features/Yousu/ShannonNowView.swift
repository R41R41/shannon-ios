import SwiftUI

/// 「シャノンのいま」: one calm page. What waits for the owner comes first; then how she
/// feels, what she does in her own time, whether her body is showing, and one quiet
/// timeline of looks, touches and messages she started. Nothing here can be changed:
/// decisions are made where they already are.
public struct ShannonNowView: View {
    @Bindable private var model: ShannonNowModel
    /// The mood of `GET /v1/state`, shown when the server has no 「いま」 read.
    private let fallbackMood: CompanionPresenceDTO.Mood?
    /// Work tasks that wait for a permission.
    private let approvals: [ShannonNowWaitingItem]
    private let openApproval: ((ShannonNowWaitingItem) -> Void)?
    private let autonomy: ShannonAutonomyModel?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    public init(
        model: ShannonNowModel,
        fallbackMood: CompanionPresenceDTO.Mood? = nil,
        approvals: [ShannonNowWaitingItem] = [],
        openApproval: ((ShannonNowWaitingItem) -> Void)? = nil,
        autonomy: ShannonAutonomyModel? = nil
    ) {
        self.model = model
        self.fallbackMood = fallbackMood
        self.approvals = approvals
        self.openApproval = openApproval
        self.autonomy = autonomy
    }

    private var waiting: [ShannonNowWaitingItem] { model.waiting(approvals: approvals) }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if let message = model.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(palette.onAttentionTint)
                        .listRowBackground(palette.attentionTint)
                }
            }
            waitingSection(palette: palette)
            feelingSection(palette: palette)
            if model.ownTime != nil { ownTimeSection(palette: palette) }
            if let now = model.now {
                bodySection(now.body, palette: palette)
                timelineSection(palette: palette)
            }
        }
        .overlay {
            if !model.didLoad, model.isLoading {
                ProgressView("ようすを確認中")
            }
        }
        .refreshable { await model.reload() }
        // Read when the page appears and when the app comes back to the front; never in the background.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.reload()
        }
    }

    // MARK: What waits for the owner

    @ViewBuilder
    private func waitingSection(palette: ShannonPalette) -> some View {
        let items = waiting
        Section {
            if items.isEmpty {
                Label(ShannonGeneratedStrings.shannonCardNothingWaiting, systemImage: "checkmark.circle")
                    .font(.callout)
                    .foregroundStyle(palette.textSecondary)
            } else {
                NavigationLink {
                    ShannonNowWaitingPage(items: items, openApproval: openApproval, autonomy: autonomy)
                } label: {
                    HStack(spacing: ShannonSpacing.medium) {
                        Text("\(items.count)")
                            .font(.footnote.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(palette.onAction)
                            .padding(.horizontal, 7)
                            .frame(minWidth: 24, minHeight: 24)
                            .background(palette.action, in: Capsule())
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("待っていること")
                                .font(.body.weight(.semibold))
                            Text(ShannonNowText.waitingSummary(items))
                                .font(.footnote)
                                .foregroundStyle(palette.textSecondary)
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("待っていること、\(items.count)件、\(ShannonNowText.waitingSummary(items))")
                }
            }
        }
    }

    // MARK: Feeling

    @ViewBuilder
    private func feelingSection(palette: ShannonPalette) -> some View {
        let feeling = model.now?.feeling
        let moodFace = feeling?.mood?.face ?? fallbackMood?.face
        let presentFace = feeling?.present?.face
        let lingering = (feeling?.lingering ?? []).compactMap { ShannonNowText.lingeringLabel($0) }
        Section {
            HStack(alignment: .center, spacing: ShannonSpacing.large) {
                ShannonAvatarView(expression: (presentFace ?? moodFace)?.expression ?? .neutral, size: 64)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                    Text(moodFace?.japaneseName ?? "まだ分かりません")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                    if let presentFace {
                        Text("いまの気持ち：\(presentFace.japaneseName)")
                            .font(.callout)
                            .foregroundStyle(palette.textPrimary)
                    }
                    ForEach(lingering, id: \.self) { label in
                        Text("まだ残っている気持ち：\(label)")
                            .font(.footnote)
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, ShannonSpacing.extraSmall)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(feelingAccessibilityLabel(mood: moodFace, present: presentFace, lingering: lingering))
            .listRowBackground(palette.intelligenceSoft)
        }
    }

    private func feelingAccessibilityLabel(mood: ShannonFace?, present: ShannonFace?, lingering: [String]) -> String {
        var parts = ["シャノンの気分、\(mood?.japaneseName ?? "まだ分かりません")"]
        if let present { parts.append("いまの気持ち、\(present.japaneseName)") }
        parts += lingering.map { "まだ残っている気持ち、\($0)" }
        return parts.joined(separator: "。")
    }

    // MARK: Her own time

    @ViewBuilder
    private func ownTimeSection(palette: ShannonPalette) -> some View {
        if let ownTime = model.ownTime {
            Section("自分の時間") {
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    if let line = model.ownTimeLine {
                        Text(line)
                            .font(.body.weight(.medium))
                            .foregroundStyle(palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let reason = model.restReason {
                        Text("シャノンのことば：\(reason)")
                            .font(.footnote)
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let latest = model.latestActivity {
                        Text("\(ShannonYousuTime.clock(latest.occurredAt)) \(latest.summary)")
                            .font(.footnote)
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("最近したこと、\(ShannonYousuTime.clock(latest.occurredAt))、\(latest.summary)")
                    }
                }
                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                    ProgressView(value: ownTime.budget.fraction)
                        .tint(palette.action)
                        .accessibilityHidden(true)
                    Text("今日の予算 \(ownTime.budget.usedLabel)")
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(palette.textSecondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("今日の予算、\(ShannonAutonomyFormat.yen(ownTime.budget.capYen))のうち\(ShannonAutonomyFormat.yen(ownTime.budget.spentYen))を使いました")
            }
        }
    }

    // MARK: Her body

    private func bodySection(_ body: ShannonNowBodyDTO, palette: ShannonPalette) -> some View {
        Section("体") {
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.medium) {
                Image(systemName: body.known && body.present ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark")
                    .foregroundStyle(palette.textSecondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonNowText.bodyLine(body))
                        .font(.callout)
                        .foregroundStyle(palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let camera = ShannonNowText.cameraLine(body) {
                        Text(camera)
                            .font(.footnote)
                            .foregroundStyle(palette.textSecondary)
                    }
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Timeline

    @ViewBuilder
    private func timelineSection(palette: ShannonPalette) -> some View {
        let events = model.timeline
        Section("最近のできごと") {
            if events.isEmpty {
                Text("まだありません")
                    .font(.callout)
                    .foregroundStyle(palette.textSecondary)
            } else {
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    let day = ShannonNowText.dayTitle(event.at)
                    let startsDay = index == 0 || ShannonNowText.dayTitle(events[index - 1].at) != day
                    ShannonNowEventRow(event: event, day: startsDay && !(index == 0 && day == "今日") ? day : nil, spokenDay: day, palette: palette)
                }
            }
        }
    }
}

/// One past event: muted, with its time, and nothing to press.
struct ShannonNowEventRow: View {
    let event: ShannonNowEvent
    /// Set on the first row of a day other than the newest one's today.
    let day: String?
    let spokenDay: String
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            if let day {
                Text(day)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityAddTraits(.isHeader)
            }
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                Text(ShannonNowText.timeOfDay(event.at))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(palette.textSecondary)
                Image(systemName: event.symbolName)
                    .font(.footnote)
                    .foregroundStyle(palette.textSecondary)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.title)
                        .font(.callout)
                        .foregroundStyle(palette.textPrimary.opacity(0.85))
                    if let detail = event.detail {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([spokenDay, ShannonNowText.timeOfDay(event.at), event.title, event.detail].compactMap { $0 }.joined(separator: "、"))
        }
    }
}

/// What waits for the owner, each with the place where it is decided.
struct ShannonNowWaitingPage: View {
    let items: [ShannonNowWaitingItem]
    let openApproval: ((ShannonNowWaitingItem) -> Void)?
    let autonomy: ShannonAutonomyModel?

    @Environment(\.shannonOpenStudyPiece) private var openStudyPiece

    var body: some View {
        List {
            ForEach(items) { item in
                row(item)
            }
        }
        .navigationTitle("待っていること")
    }

    @ViewBuilder
    private func row(_ item: ShannonNowWaitingItem) -> some View {
        switch item.kind {
        case .reaction:
            if let openStudyPiece {
                Button { openStudyPiece(String(item.id.dropFirst("piece-".count))) } label: { label(item, opens: true) }
                    .buttonStyle(.plain)
                    .accessibilityHint("書斎で開きます")
            } else {
                label(item, opens: false)
            }
        case .decision:
            if let autonomy {
                NavigationLink { ShannonAutonomyActivityPage(model: autonomy) } label: { label(item, opens: false) }
            } else {
                label(item, opens: false)
            }
        case .approval:
            if let openApproval {
                Button { openApproval(item) } label: { label(item, opens: true) }
                    .buttonStyle(.plain)
                    .accessibilityHint("作業を開きます")
            } else {
                label(item, opens: false)
            }
        }
    }

    private func label(_ item: ShannonNowWaitingItem, opens: Bool) -> some View {
        HStack(spacing: ShannonSpacing.medium) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.kind.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(item.title)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                Text(item.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if opens {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
