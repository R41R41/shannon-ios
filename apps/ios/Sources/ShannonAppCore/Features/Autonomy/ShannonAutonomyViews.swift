import SwiftUI

/// 頭の中 section: Shannon's own pursuits, kept apart from the owner's goals, and
/// the entrance to the activity record. Read-only here.
struct ShannonAutonomyHubSection: View {
    @Bindable var model: ShannonAutonomyModel
    let palette: ShannonPalette

    var body: some View {
        if model.isSupported {
            Section {
                if model.overview == nil {
                    Text(model.errorMessage ?? "読み込み中…")
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                        .listRowBackground(palette.subtleSurface)
                } else {
                    NavigationLink {
                        ShannonAutonomyPursuitsPage(model: model)
                    } label: {
                        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                            ForEach(model.featuredPursuits) { pursuit in
                                ShannonPursuitLine(pursuit: pursuit, palette: palette)
                            }
                            if model.featuredPursuits.isEmpty {
                                Text("いま続けているものはありません")
                                    .foregroundStyle(palette.textSecondary)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    }
                    .accessibilityHint("シャノン自身の目標・問い・作品の一覧を開きます")
                    .accessibilityIdentifier("autonomy-pursuits-entry")
                    .listRowBackground(palette.subtleSurface)
                }

                if model.study.isSupported {
                    NavigationLink {
                        ShannonStudyPage(study: model.study)
                    } label: {
                        ShannonStudyEntryLabel(study: model.study, tint: palette.action)
                            .foregroundStyle(palette.textPrimary)
                    }
                    .accessibilityIdentifier("autonomy-study-entry")
                    .listRowBackground(palette.subtleSurface)
                }

                NavigationLink {
                    ShannonAutonomyActivityPage(model: model)
                } label: {
                    LabeledContent {
                        Text(model.summary)
                            .foregroundStyle(palette.textSecondary)
                    } label: {
                        Label {
                            Text("したことの記録").foregroundStyle(palette.textPrimary)
                        } icon: {
                            Image(systemName: "list.bullet.clipboard").foregroundStyle(palette.action)
                        }
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .accessibilityElement(children: .combine)
                }
                .accessibilityHint("シャノンが自分からしたこと、今日の予算、一時停止を開きます")
                .accessibilityIdentifier("autonomy-activity-entry")
                .listRowBackground(palette.subtleSurface)
                .task { await model.loadIfNeeded() }
            } header: {
                Text("シャノンのやりたいこと")
            } footer: {
                Text("あなたの目的とは別に、シャノン自身が持っている目標と問いです。")
            }
        }
    }
}

/// Mac 頭の中: the same two entrances as a card in the overview column.
struct ShannonAutonomyOverviewCard: View {
    @Bindable var model: ShannonAutonomyModel
    let palette: ShannonPalette

    var body: some View {
        if model.isSupported {
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                Text("シャノンのやりたいこと")
                    .font(.headline)
                    .foregroundStyle(palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                NavigationLink {
                    ShannonAutonomyPursuitsPage(model: model)
                } label: {
                    HStack(alignment: .top, spacing: ShannonSpacing.medium) {
                        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                            ForEach(model.featuredPursuits) { pursuit in
                                ShannonPursuitLine(pursuit: pursuit, palette: palette)
                            }
                            if model.featuredPursuits.isEmpty {
                                Text(model.overview == nil ? (model.errorMessage ?? "読み込み中…") : "いま続けているものはありません")
                                    .foregroundStyle(palette.textSecondary)
                            }
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(palette.textSecondary).accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("シャノン自身の目標・問い・作品の一覧を開きます")
                .accessibilityIdentifier("autonomy-pursuits-entry")
                Divider()
                if model.study.isSupported {
                    NavigationLink {
                        ShannonStudyPage(study: model.study)
                    } label: {
                        HStack(spacing: ShannonSpacing.small) {
                            ShannonStudyEntryLabel(study: model.study, tint: palette.action)
                                .foregroundStyle(palette.textPrimary)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(palette.textSecondary).accessibilityHidden(true)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("autonomy-study-entry")
                    Divider()
                }
                NavigationLink {
                    ShannonAutonomyActivityPage(model: model)
                } label: {
                    HStack(spacing: ShannonSpacing.medium) {
                        Image(systemName: "list.bullet.clipboard").foregroundStyle(palette.action).accessibilityHidden(true)
                        Text("したことの記録").foregroundStyle(palette.textPrimary)
                        Spacer(minLength: 0)
                        Text(model.summary).font(.callout).foregroundStyle(palette.textSecondary)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(palette.textSecondary).accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    .contentShape(Rectangle())
                    .accessibilityElement(children: .combine)
                }
                .buttonStyle(.plain)
                .accessibilityHint("シャノンが自分からしたこと、今日の予算、一時停止を開きます")
                .accessibilityIdentifier("autonomy-activity-entry")
                Text("あなたの目的とは別に、シャノン自身が持っている目標と問いです。")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }
            .padding(ShannonSpacing.large)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
            .task { await model.loadIfNeeded() }
        }
    }
}

struct ShannonPursuitLine: View {
    let pursuit: ShannonPursuitDTO
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Image(systemName: pursuit.kindSymbol)
                .foregroundStyle(palette.brandPresence)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(pursuit.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(pursuit.kindLabel) ・ \(pursuit.statusLabel)")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The whole ledger. The owner reads it; the only change offered is telling her
/// to rest or drop an entry that is her own.
struct ShannonAutonomyPursuitsPage: View {
    @Bindable var model: ShannonAutonomyModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var pursuitToDrop: ShannonPursuitDTO?

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if let message = model.errorMessage {
                Section {
                    Text(message).font(.footnote).foregroundStyle(palette.danger)
                }
            }
            let open = model.pursuits.filter(\.isOpen)
            if !open.isEmpty {
                Section("いま") {
                    ForEach(open) { pursuit in pursuitRow(pursuit, palette: palette) }
                }
            }
            let closed = model.pursuits.filter { !$0.isOpen }
            if !closed.isEmpty {
                Section("終えたもの・やめたもの") {
                    ForEach(closed) { pursuit in pursuitRow(pursuit, palette: palette) }
                }
            }
            if !(model.overview?.modelChoices ?? []).isEmpty {
                Section {
                    ForEach(model.overview?.modelChoices ?? []) { choice in
                        VStack(alignment: .leading, spacing: 2) {
                            LabeledContent(choice.purposeLabel, value: choice.modelLabel)
                            Text([choice.chosenByLabel, choice.reason, choice.recommendation].compactMap { $0 }.joined(separator: " ・ "))
                                .font(.caption)
                                .foregroundStyle(palette.textSecondary)
                        }
                        .frame(minHeight: ShannonTouchTarget.minimum)
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    Text("使うモデル")
                } footer: {
                    Text("何にどのモデルを使うかは、シャノンが選びます。使った分は今日の予算から引かれます。")
                }
            }
        }
        .navigationTitle("シャノンのやりたいこと")
        .overlay {
            if model.pursuits.isEmpty, !model.isLoading {
                ContentUnavailableView(
                    "まだありません",
                    systemImage: "flag",
                    description: Text("接続後、シャノン自身の目標と問いがここに表示されます。")
                )
            }
        }
        .refreshable { await model.reload() }
        .task { await model.loadIfNeeded() }
        .confirmationDialog(
            "やめるよう伝えますか？",
            isPresented: Binding(get: { pursuitToDrop != nil }, set: { if !$0 { pursuitToDrop = nil } }),
            titleVisibility: .visible,
            presenting: pursuitToDrop
        ) { pursuit in
            Button("やめるよう伝える", role: .destructive) {
                Task { await model.setPursuit(pursuit, status: "dropped") }
            }
            Button("キャンセル", role: .cancel) {}
        } message: { pursuit in
            Text("「\(pursuit.title)」は元に戻せません。記録には残ります。")
        }
    }

    private func pursuitRow(_ pursuit: ShannonPursuitDTO, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            ShannonPursuitLine(pursuit: pursuit, palette: palette)
            Text(pursuit.why)
                .font(.callout)
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("理由、\(pursuit.why)")
            Text(pursuit.originLabel)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
            ForEach(pursuit.links, id: \.url) { link in
                if let url = URL(string: link.url), url.scheme == "https" {
                    Link(link.label, destination: url)
                        .font(.callout)
                        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                } else {
                    Label(link.label, systemImage: "doc.text")
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                }
            }
            if pursuit.ownerCanRest || pursuit.ownerCanDrop {
                HStack(spacing: ShannonSpacing.medium) {
                    if pursuit.ownerCanRest {
                        Button("休ませる") {
                            Task { await model.setPursuit(pursuit, status: "resting") }
                        }
                        .accessibilityHint("シャノンに、これをいったん休むよう伝えます")
                    }
                    if pursuit.ownerCanDrop {
                        Button("やめてもらう", role: .destructive) { pursuitToDrop = pursuit }
                            .accessibilityHint("シャノンに、これをやめるよう伝えます。確認があります")
                    }
                    if model.decidingID == pursuit.id {
                        ProgressView().controlSize(.small).accessibilityLabel("保存中")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(model.decidingID != nil)
                .frame(minHeight: ShannonTouchTarget.minimum)
            }
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
    }
}

/// Settings section shared by iPhone and Mac: the stop switch and the way to the record.
public struct ShannonAutonomySettingsSection: View {
    @Bindable private var model: ShannonAutonomyModel
    @State private var showsActivity = false

    public init(model: ShannonAutonomyModel) {
        self.model = model
    }

    public var body: some View {
        if model.isSupported {
            Section {
                ShannonAutonomyPauseToggle(model: model)
                Button {
                    showsActivity = true
                } label: {
                    LabeledContent {
                        Text(model.summary).foregroundStyle(.secondary)
                    } label: {
                        Label("したことの記録", systemImage: "list.bullet.clipboard")
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("シャノンが自分からしたことと今日の予算を開きます")
                .accessibilityIdentifier("settings-autonomy-activity")
                .task { await model.loadIfNeeded() }
                .sheet(isPresented: $showsActivity) {
                    NavigationStack {
                        ShannonAutonomyActivityPage(model: model)
                            .toolbar {
                                ToolbarItem(placement: .confirmationAction) {
                                    Button("完了") { showsActivity = false }
                                }
                            }
                    }
#if os(macOS)
                    .frame(minWidth: 520, minHeight: 560)
#endif
                }
                if let message = model.errorMessage {
                    Text(message).font(.footnote).foregroundStyle(Color.shannonDanger)
                }
            } header: {
                Text("シャノンの自律")
            } footer: {
                Text(model.overview?.stateDetail ?? "シャノンが自分から動く範囲・予算・記録を確認できます。")
            }
        }
    }
}

/// The stop switch. On means paused; it changes only after the server stored it.
struct ShannonAutonomyPauseToggle: View {
    @Bindable var model: ShannonAutonomyModel

    var body: some View {
        Toggle(isOn: Binding(
            get: { model.control?.paused ?? false },
            set: { paused in Task { await model.setPaused(paused) } }
        )) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("自律活動を一時停止")
                    Text(model.stateLabel)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("autonomy-loop-state")
                }
            } icon: {
                Image(systemName: model.overview?.stateSymbol ?? "pause.circle")
            }
        }
        .disabled(model.overview == nil || model.isChangingPause)
        .frame(minHeight: ShannonTouchTarget.minimum)
        .accessibilityHint("オンにすると、シャノンは自分からは何もしません。会話や、あなたが始めた作業は続きます")
        .accessibilityIdentifier("autonomy-pause-toggle")
    }
}
