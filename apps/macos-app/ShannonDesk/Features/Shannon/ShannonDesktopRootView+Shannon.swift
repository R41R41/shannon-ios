import AppKit
import ShannonAppCore
import SwiftUI

/// 「シャノン」 on the Mac (docs/product/information-architecture.md, 2): choosing it in the sidebar
/// shows a second column with the card (her now and what waits; it opens ようす) and the rows
/// 頭の中／自律活動／書斎, and the chosen page on the right (ようす at first).
extension ShannonDesktopRootView {
    var shannonPage: DesktopShannonPage {
        DesktopShannonPage.restoring(shannonPageRawValue)
    }

    func selectShannonPage(_ page: DesktopShannonPage) {
        shannonPageRawValue = page.rawValue
    }

    var shannonHub: some View {
        HStack(spacing: 0) {
            shannonHubColumn
                .frame(width: 290)
            Divider()
            NavigationStack {
                shannonHubContent
            }
            .id(shannonPage)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle(ShannonGeneratedStrings.navShannon)
        .task { await reloadShannonHub() }
    }

    private var shannonHubColumn: some View {
        List(selection: Binding(
            get: { shannonPage },
            set: { page in if let page { selectShannonPage(page) } }
        )) {
            Section {
                ShannonHubCard(
                    now: yousu.now,
                    fallbackMood: conversation.state?.presence?.mood,
                    approvals: conversation.waitingApprovals,
                    isSelected: shannonPage == .now
                ) {
                    selectShannonPage(.now)
                }
                .tag(DesktopShannonPage.now)
            }
            Section {
                shannonHubRow(ShannonGeneratedStrings.navMemory, symbol: "brain.head.profile", detail: nil)
                    .tag(DesktopShannonPage.memory)
                    .accessibilityHint(ShannonGeneratedStrings.hubMemoryHint)
                if memory.autonomy.isSupported {
                    shannonHubRow(
                        ShannonGeneratedStrings.navAutonomy,
                        symbol: "sparkles",
                        detail: memory.autonomy.overview == nil ? nil : memory.autonomy.stateLabel
                    )
                    .tag(DesktopShannonPage.autonomy)
                    .accessibilityHint(ShannonGeneratedStrings.hubAutonomyHint)
                }
                if memory.autonomy.study.isSupported {
                    shannonHubRow(ShannonGeneratedStrings.navStudy, symbol: "books.vertical", detail: memory.autonomy.study.summary)
                        .tag(DesktopShannonPage.study)
                        .accessibilityHint("シャノンが自分の時間に書いたメモと物語を開きます")
                }
            }
        }
        .listStyle(.sidebar)
    }

    @ViewBuilder
    private var shannonHubContent: some View {
        switch shannonPage {
        case .now:
            ShannonYousuView(
                model: yousu,
                fallbackMood: conversation.state?.presence?.mood,
                approvals: conversation.waitingApprovals,
                openApproval: { item in
                    guard let id = UUID(uuidString: item.id),
                          let task = conversation.agentTasks.first(where: { $0.id == id }) else { return }
                    selectDestination(.work)
                    selectTask(task)
                },
                autonomy: memory.autonomy
            )
        case .memory:
            ShannonMemoryView(model: memory, showsDismissButton: false)
                .navigationTitle(ShannonGeneratedStrings.navMemory)
        case .autonomy:
            ShannonAutonomyActivityPage(model: memory.autonomy, isHub: true)
        case .study:
            ShannonStudyPage(study: memory.autonomy.study)
        }
    }

    private func shannonHubRow(_ title: String, symbol: String, detail: String?) -> some View {
        LabeledContent {
            if let detail {
                Text(detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        } label: {
            Label(title, systemImage: symbol)
        }
        .frame(minHeight: ShannonDesktopMetrics.rowHeight)
        .accessibilityElement(children: .combine)
    }

    func reloadShannonHub() async {
        guard !conversation.isDesignPreview else { return }
        async let now: Void = yousu.now.reload()
        async let own: Void = memory.autonomy.loadIfNeeded()
        async let study: Void = memory.autonomy.study.loadIfNeeded()
        _ = await (now, own, study)
    }
}
