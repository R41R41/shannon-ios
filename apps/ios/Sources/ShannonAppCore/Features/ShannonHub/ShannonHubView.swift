import SwiftUI

/// 「シャノン」, the third of the four entries (docs/product/information-architecture.md):
/// a card with how she is now and what waits for the owner, which opens ようす, then
/// 頭の中, 自律活動 and 書斎. One column on the iPhone; each row pushes its page.
struct ShannonHubView: View {
    let yousu: ShannonYousuModel
    @Bindable var memory: ShannonMemoryModel
    /// The mood of `GET /v1/state`, for when the server has no 「いま」 read.
    let fallbackMood: CompanionPresenceDTO.Mood?
    /// Work tasks that wait for a permission: they wait for the owner too.
    let approvals: [ShannonNowWaitingItem]
    let openApproval: (ShannonNowWaitingItem) -> Void
    /// ようす is open. Set by the card and by a `shannon://yousu` link.
    @Binding var showsYousu: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    private var autonomy: ShannonAutonomyModel { memory.autonomy }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            Section {
                ShannonHubCard(now: yousu.now, fallbackMood: fallbackMood, approvals: approvals) { showsYousu = true }
                    .listRowBackground(palette.intelligenceSoft)
            }
            Section {
                NavigationLink {
                    ShannonMemoryView(model: memory, showsDismissButton: false)
                        .navigationTitle(ShannonGeneratedStrings.navMemory)
                } label: {
                    row(ShannonGeneratedStrings.navMemory, symbol: "brain.head.profile", detail: nil, palette: palette)
                }
                .accessibilityHint(ShannonGeneratedStrings.hubMemoryHint)
                .accessibilityIdentifier("shannon-hub-memory")
                if autonomy.isSupported {
                    NavigationLink {
                        ShannonAutonomyActivityPage(model: autonomy, isHub: true)
                    } label: {
                        row(ShannonGeneratedStrings.navAutonomy, symbol: "sparkles", detail: autonomy.overview == nil ? nil : autonomy.stateLabel, palette: palette)
                    }
                    .accessibilityHint(ShannonGeneratedStrings.hubAutonomyHint)
                    .accessibilityIdentifier("shannon-hub-autonomy")
                }
                if autonomy.study.isSupported {
                    NavigationLink {
                        ShannonStudyPage(study: autonomy.study)
                    } label: {
                        row(ShannonGeneratedStrings.navStudy, symbol: "books.vertical", detail: autonomy.study.summary, palette: palette)
                    }
                    .accessibilityHint("シャノンが自分の時間に書いたメモと物語を開きます")
                    .accessibilityIdentifier("shannon-hub-study")
                }
            }
        }
#if os(iOS)
        .listStyle(.insetGrouped)
#endif
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .navigationDestination(isPresented: $showsYousu) {
            ShannonYousuView(
                model: yousu, fallbackMood: fallbackMood,
                approvals: approvals, openApproval: openApproval, autonomy: autonomy
            )
        }
        .refreshable { await reload() }
        // Read when the page appears and when the app comes back to the front; never in the background.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await reload()
        }
    }

    private func reload() async {
        async let now: Void = yousu.now.reload()
        async let own: Void = autonomy.loadIfNeeded()
        async let study: Void = autonomy.study.loadIfNeeded()
        _ = await (now, own, study)
    }

    private func row(_ title: String, symbol: String, detail: String?, palette: ShannonPalette) -> some View {
        LabeledContent {
            if let detail {
                Text(detail)
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(1)
            }
        } label: {
            Label {
                Text(title).foregroundStyle(palette.textPrimary)
            } icon: {
                Image(systemName: symbol).foregroundStyle(palette.action)
            }
        }
        .frame(minHeight: ShannonTouchTarget.minimum)
        .accessibilityElement(children: .combine)
    }
}
