import SwiftUI

/// 「シャノン › ようす」: シャノンのいま, and only that (decision 2026-10-03). The services of the
/// legacy runtime are 「設定 › 管理 › 運用」 (`ShannonOpsView`).
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
        ShannonNowView(
            model: model.now, fallbackMood: fallbackMood, approvals: approvals,
            openApproval: openApproval, autonomy: autonomy
        )
        .navigationTitle(ShannonGeneratedStrings.navYousu)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .tint(ShannonPalette.resolve(colorScheme).action)
    }
}
