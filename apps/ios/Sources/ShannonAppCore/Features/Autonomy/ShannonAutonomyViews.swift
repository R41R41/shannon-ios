import SwiftUI

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
                    .font(.shannon(.body).weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(pursuit.kindLabel) ・ \(pursuit.statusLabel)")
                    .font(.shannon(.caption))
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
                    Text(message).font(.shannon(.footnote)).foregroundStyle(palette.danger)
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
                                .font(.shannon(.caption))
                                .foregroundStyle(palette.textSecondary)
                        }
                        .frame(minHeight: ShannonTouchTarget.minimum)
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    Text(ShannonGeneratedStrings.autonomyModelsTitle)
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
                .font(.shannon(.callout))
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("理由、\(pursuit.why)")
            Text(pursuit.originLabel)
                .font(.shannon(.caption))
                .foregroundStyle(palette.textSecondary)
            ForEach(pursuit.links, id: \.url) { link in
                if let url = URL(string: link.url), url.scheme == "https" {
                    Link(link.label, destination: url)
                        .font(.shannon(.callout))
                        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                } else {
                    Label(link.label, systemImage: "doc.text")
                        .font(.shannon(.callout))
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
                        .font(.shannon(.footnote))
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
