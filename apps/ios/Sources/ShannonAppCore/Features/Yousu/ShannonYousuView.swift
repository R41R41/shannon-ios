import SwiftUI

/// 「ようす」: 「シャノンのいま」 and 「運用」 behind one switch. The switch appears only
/// once the legacy runtime has reported at least once; until then there is nothing to
/// operate and the page is 「シャノンのいま」 alone. The last segment is remembered on this device.
public struct ShannonYousuView: View {
    @Bindable private var model: ShannonYousuModel
    /// A segment asked for from outside (a link). It wins over the remembered one, and shows
    /// 運用 even before a report arrived, where the page then says so.
    private let requested: ShannonYousuSegment?
    private let fallbackMood: CompanionPresenceDTO.Mood?
    private let approvals: [ShannonNowWaitingItem]
    private let openApproval: ((ShannonNowWaitingItem) -> Void)?
    private let autonomy: ShannonAutonomyModel?

    @AppStorage(ShannonYousuSegment.storageKey) private var storedSegment = ShannonYousuSegment.now.rawValue
    @State private var forcedOps = false
    @Environment(\.colorScheme) private var colorScheme

    public init(
        model: ShannonYousuModel,
        requested: ShannonYousuSegment? = nil,
        fallbackMood: CompanionPresenceDTO.Mood? = nil,
        approvals: [ShannonNowWaitingItem] = [],
        openApproval: ((ShannonNowWaitingItem) -> Void)? = nil,
        autonomy: ShannonAutonomyModel? = nil
    ) {
        self.model = model
        self.requested = requested
        self.fallbackMood = fallbackMood
        self.approvals = approvals
        self.openApproval = openApproval
        self.autonomy = autonomy
    }

    private var showsSwitch: Bool { model.ops.hasReport || forcedOps }

    private var segment: ShannonYousuSegment {
        let stored = ShannonYousuSegment(rawValue: storedSegment) ?? .now
        return stored == .ops && !showsSwitch ? .now : stored
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Group {
            switch segment {
            case .now:
                ShannonNowView(
                    model: model.now, fallbackMood: fallbackMood, approvals: approvals,
                    openApproval: openApproval, autonomy: autonomy
                )
            case .ops:
                ShannonOpsView(model: model.ops)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if showsSwitch {
                Picker("表示する内容", selection: Binding(
                    get: { segment },
                    set: { storedSegment = $0.rawValue }
                )) {
                    ForEach(ShannonYousuSegment.allCases) { item in
                        Text(item == .ops && model.needsAttention ? "\(item.title) !" : item.title)
                            .accessibilityLabel(item == .ops && model.needsAttention ? "運用、確かめたいことがあります" : item.title)
                            .tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, ShannonSpacing.large)
                .padding(.vertical, ShannonSpacing.small)
                .background(.bar)
            }
        }
        .navigationTitle("ようす")
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .tint(palette.action)
        .onAppear { apply(requested) }
        .onChange(of: requested) { apply(requested) }
        // One read, so the switch can appear; the 運用 page does its own reading while it is on screen.
        .task {
            if !model.ops.didLoad { await model.ops.refresh() }
        }
    }

    private func apply(_ segment: ShannonYousuSegment?) {
        guard let segment else { return }
        if segment == .ops { forcedOps = true }
        storedSegment = segment.rawValue
    }
}
