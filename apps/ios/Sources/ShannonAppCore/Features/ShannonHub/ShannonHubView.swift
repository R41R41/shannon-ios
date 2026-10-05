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
    private var waiting: [ShannonNowWaitingItem] { yousu.now.waiting(approvals: approvals) }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            Section {
                card(palette: palette)
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

    // MARK: The card

    private var moodFace: ShannonFace? {
        yousu.now.now?.feeling.present?.face ?? yousu.now.now?.feeling.mood?.face ?? fallbackMood?.face
    }

    private var waitingLine: String {
        let items = waiting
        guard !items.isEmpty else { return ShannonGeneratedStrings.shannonCardNothingWaiting }
        return ShannonGeneratedStrings.hubCardWaiting(count: String(items.count), summary: ShannonNowText.waitingSummary(items))
    }

    private func card(palette: ShannonPalette) -> some View {
        Button {
            showsYousu = true
        } label: {
            HStack(alignment: .center, spacing: ShannonSpacing.medium) {
                ShannonAvatarView(expression: moodFace?.expression ?? .neutral, size: 56)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                    Text(ShannonGeneratedStrings.navNow)
                        .font(.shannon(.caption).weight(.semibold))
                        .foregroundStyle(palette.textSecondary)
                    Text(moodFace?.japaneseName ?? "まだ分かりません")
                        .font(.shannon(.title3).weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                    if let line = yousu.now.ownTimeLine {
                        Text(line)
                            .font(.shannon(.footnote))
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(waitingLine)
                        .font(.shannon(.callout).weight(waiting.isEmpty ? .regular : .semibold))
                        .foregroundStyle(waiting.isEmpty ? palette.textSecondary : palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.shannon(.caption).weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, ShannonSpacing.small)
            .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(cardAccessibilityLabel)
        .accessibilityHint(ShannonGeneratedStrings.hubCardHint)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("shannon-hub-card")
    }

    private var cardAccessibilityLabel: String {
        [ShannonGeneratedStrings.navNow, moodFace?.japaneseName ?? "まだ分かりません", yousu.now.ownTimeLine, waitingLine]
            .compactMap { $0 }
            .joined(separator: "、")
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
