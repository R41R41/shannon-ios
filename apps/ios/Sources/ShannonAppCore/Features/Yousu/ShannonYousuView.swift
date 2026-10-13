import SwiftUI

/// 「シャノン › ようす」: シャノンのいま (decision 2026-10-03), with 学び and 気分 beside it (Syzygy ADR-0008 §13, option A,
/// owner 2026-10-07): a switch いま／学び／気分 at the top, with 目標 and 点検 (Syzygy ADR-0009 E7) for the owner alone.
/// The services of the legacy runtime are 「設定 › 管理 › 運用」
/// (`ShannonOpsView`).
public struct ShannonYousuView: View {
    @Bindable private var model: ShannonYousuModel
    private let fallbackMood: CompanionPresenceDTO.Mood?
    private let approvals: [ShannonNowWaitingItem]
    private let openApproval: ((ShannonNowWaitingItem) -> Void)?
    private let autonomy: ShannonAutonomyModel?

    @Environment(\.colorScheme) private var colorScheme

    public init(
        model: ShannonYousuModel,
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

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        page
            .safeAreaInset(edge: .top, spacing: 0) {
                tabPicker
                    .padding(.horizontal, ShannonSpacing.large)
                    .padding(.vertical, ShannonSpacing.small)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
            }
            .navigationTitle(ShannonGeneratedStrings.navYousu)
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .tint(palette.action)
            // Whether 学び is offered is learned beside the page: a device that may not read it never sees the tab.
            .task {
                if model.learning.skills == nil, model.learning.values == nil { await model.learning.reload() }
            }
            .onChange(of: model.learning.isUnavailable) { _, unavailable in
                if unavailable, ShannonYousuModel.ownerPages.contains(model.tab) { model.tab = .now }
            }
    }

    @ViewBuilder
    private var page: some View {
        switch model.tab {
        case .now, .mood:
            ShannonNowView(
                model: model.now, fallbackMood: fallbackMood, approvals: approvals,
                openApproval: openApproval, autonomy: autonomy, content: model.tab == .mood ? .mood : .now
            )
            .id(model.tab)
        case .learning:
            ShannonLearningView(model: model.learning)
        case .goals:
            ShannonGoalsView(model: model.executive)
        case .inspection:
            ShannonInspectionView(model: model.executive)
        }
    }

    /// Above the list, never inside it. On the Mac the switch is drawn by SwiftUI (`ShannonSegmentedChoice`), as elsewhere in ようす.
    @ViewBuilder
    private var tabPicker: some View {
#if os(iOS)
        Picker(ShannonGeneratedStrings.yousuTabLabel, selection: $model.tab) {
            ForEach(model.tabs) { tab in
                Text(tab.title).tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(maxWidth: 360)
#else
        ShannonSegmentedChoice(
            ShannonGeneratedStrings.yousuTabLabel, selection: $model.tab,
            options: model.tabs.map { .init($0.title, value: $0) }
        )
#endif
    }
}

/// Tells ようす whether someone besides the owner may see or hear (the same rule as 「いま」's reads): 目標 and 点検 are offered
/// only while the owner is alone, and an open one goes back to いま when someone joins.
public struct ShannonYousuAudience: ViewModifier {
    let model: ShannonYousuModel
    let othersPresent: Bool

    public init(model: ShannonYousuModel, othersPresent: Bool) {
        self.model = model
        self.othersPresent = othersPresent
    }

    public func body(content: Content) -> some View {
        content.onChange(of: othersPresent, initial: true) { model.othersPresent = othersPresent }
    }
}
