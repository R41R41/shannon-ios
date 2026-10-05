import SwiftUI

/// iPhone 頭の中: the いま card on the intelligence surface, then an
/// inset-grouped list of categories that push pages reusing the section views.
struct ShannonMemoryHubList: View {
    @Bindable var model: ShannonMemoryModel
    var workspaceTopInset: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let overview = ShannonMemoryOverview(model: model)
        List {
            nowSection(overview, palette: palette)
            errorSection(model.cognitionErrorMessage, palette: palette)
            errorSection(model.errorMessage, palette: palette)
            categorySection(overview, palette: palette)
            Section {
                NavigationLink {
                    ShannonMemoryActivityPage(model: model)
                } label: {
                    ShannonMemoryCategoryRow(
                        title: "使用量と活動",
                        symbol: "gauge.with.dots.needle.50percent",
                        value: overview.usageAndActivityValue,
                        palette: palette
                    )
                }
                .accessibilityIdentifier("memory-category-usage-activity")
                .listRowBackground(palette.subtleSurface)
            } footer: {
                Text("AI使用量、最近の自発性、静かに除外した重複候補、活動履歴")
            }
        }
#if os(iOS)
        .listStyle(.insetGrouped)
#else
        .listStyle(.inset)
#endif
        .scrollContentBackground(.hidden)
        .contentMargins(.top, max(ShannonSpacing.small, workspaceTopInset), for: .scrollContent)
        .contentMargins(.bottom, ShannonSpacing.huge, for: .scrollContent)
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
    }

    // MARK: いま

    @ViewBuilder
    private func nowSection(_ overview: ShannonMemoryOverview, palette: ShannonPalette) -> some View {
        let surface = palette.intelligenceSoft.opacity(colorScheme == .dark ? 0.7 : 0.55)
        Section {
            NavigationLink {
                ShannonMemoryCurrentStatePage(model: model)
            } label: {
                ShannonMemoryNowHeader(
                    overview: overview,
                    isLoading: model.isLoading && model.dashboard == nil,
                    palette: palette
                )
            }
            .accessibilityIdentifier("memory-now-entry")
            .listRowBackground(surface)

            Text("続けている目的")
                .font(.shannon(.caption).weight(.semibold))
                .foregroundStyle(palette.textSecondary)
                .accessibilityAddTraits(.isHeader)
                .listRowBackground(surface)

            if overview.featuredIntents.isEmpty {
                NavigationLink {
                    ShannonCognitionView(model: model)
                } label: {
                    ShannonMemoryIntentPill(
                        title: emptyIntentText(overview),
                        detail: "目的と認知履歴を開く",
                        palette: palette
                    )
                }
                .accessibilityIdentifier("cognition-management-entry")
                .listRowBackground(surface)
            } else {
                ForEach(overview.featuredIntents) { intent in
                    NavigationLink {
                        ShannonCognitionView(model: model)
                    } label: {
                        ShannonMemoryIntentPill(
                            title: intent.title,
                            detail: intent.nextStep.map { "次の一手：\($0)" },
                            palette: palette
                        )
                    }
                    .accessibilityHint("目的の確認・一時停止・完了・再開を開きます")
                    .accessibilityIdentifier("memory-now-intent-\(intent.id)")
                    .listRowBackground(surface)
                }
                if overview.hiddenActiveIntentCount > 0 {
                    NavigationLink {
                        ShannonCognitionView(model: model)
                    } label: {
                        Text("ほか\(overview.hiddenActiveIntentCount)件の目的")
                            .font(.shannon(.callout))
                            .foregroundStyle(palette.action)
                            .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    }
                    .listRowBackground(surface)
                }
            }

        }
    }

    private func emptyIntentText(_ overview: ShannonMemoryOverview) -> String {
        if model.isLoading && model.cognition == .empty { return "目的を読み込み中…" }
        // The failure itself is explained once, by the error card below the いま card.
        if overview.hasCognitionError && model.cognition == .empty { return "目的と認知履歴" }
        return "続けている目的はありません"
    }

    /// A load failure in its own section so it never breaks the rounded card above it.
    @ViewBuilder
    private func errorSection(_ message: String?, palette: ShannonPalette) -> some View {
        if let message {
            Section {
                MemoryErrorCard(message: message, palette: palette) {
                    Task { await model.reload() }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
    }

    // MARK: Categories

    @ViewBuilder
    private func categorySection(_ overview: ShannonMemoryOverview, palette: ShannonPalette) -> some View {
        Section {
            ForEach(ShannonMemoryOverview.Category.allCases) { category in
                NavigationLink {
                    ShannonMemoryCategoryPage(model: model, category: category)
                } label: {
                    ShannonMemoryCategoryRow(
                        title: category.title,
                        symbol: category.symbol,
                        value: overview.value(for: category),
                        palette: palette
                    )
                }
                .accessibilityIdentifier("memory-category-\(category.rawValue)")
                .listRowBackground(palette.subtleSurface)
            }
            NavigationLink {
                ShannonPeopleListPage(model: model)
            } label: {
                ShannonMemoryCategoryRow(
                    title: ShannonPeopleMemoryCopy.title,
                    symbol: "person.2",
                    value: overview.peopleValue,
                    palette: palette
                )
            }
            .accessibilityIdentifier("memory-category-people")
            .listRowBackground(palette.subtleSurface)
            NavigationLink {
                ShannonMemoryLibraryView(model: model)
            } label: {
                ShannonMemoryManagementRow(summary: overview.managementSummary, palette: palette)
            }
            .accessibilityIdentifier("memory-management-entry")
            .listRowBackground(palette.subtleSurface)

        } header: {
            Text("記憶")
        } footer: {
            Text("忘れた・事実ではないと指定した記憶は物理削除されず、記憶の管理から復元できます。")
        }
    }
}

struct ShannonMemoryNowHeader: View {
    let overview: ShannonMemoryOverview
    let isLoading: Bool
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .center, spacing: ShannonSpacing.medium) {
            ShannonWaterlightEyeView(
                expression: overview.mood?.expression ?? .neutral,
                activity: isLoading ? .thinking : .idle,
                size: 52,
                allowsTracking: false
            )
            // Decorative presence inside a navigation row; the text below is
            // the semantic authority, so the eye takes no touches or focus.
            .allowsHitTesting(false)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("いま")
                    .font(.shannon(.caption).weight(.semibold))
                    .foregroundStyle(palette.brandPresence)
                Text(moodText)
                    .font(.shannon(.title3).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let line = overview.thinkingLine {
                    Text(line)
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(2)
                        .accessibilityLabel("考えていること、\(line)")
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .padding(.vertical, ShannonSpacing.extraSmall)
        .accessibilityElement(children: .combine)
    }

    private var moodText: String {
        if let mood = overview.mood { return mood.label }
        return isLoading ? "読み込み中…" : "いまの状態はまだありません"
    }
}

struct ShannonMemoryIntentPill: View {
    let title: String
    let detail: String?
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Image(systemName: "target")
                .foregroundStyle(palette.brandPresence)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.shannon(.body).weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                    .lineLimit(3)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct ShannonMemoryCategoryRow: View {
    let title: String
    let symbol: String
    let value: ShannonMemoryOverview.Value
    let palette: ShannonPalette

    var body: some View {
        LabeledContent {
            if let label = value.label {
                Text(label)
                    .monospacedDigit()
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityLabel(value.accessibilityValue)
            } else {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel(value.accessibilityValue)
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

struct ShannonMemoryManagementRow: View {
    let summary: String
    let palette: ShannonPalette

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("記憶の管理")
                    .foregroundStyle(palette.textPrimary)
                Text(summary)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                Text("保存した記憶・忘れた記憶の訂正・完了・取り消し・復元")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }
        } icon: {
            Image(systemName: "tray.full").foregroundStyle(palette.action)
        }
        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
