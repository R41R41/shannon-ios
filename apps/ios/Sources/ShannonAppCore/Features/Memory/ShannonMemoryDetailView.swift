import SwiftUI

struct ShannonMemoryDetailView: View {
    @Bindable var model: ShannonMemoryModel
    let memoryID: String
    @State var showsCorrection = false
    @State var correction = ""
    @State var destructiveAction: ShannonMemoryActionDTO?
    @Environment(\.colorScheme) var colorScheme

    var item: ShannonMemoryItemDTO? { model.dashboard?.items.first { $0.id == memoryID } }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ScrollView {
            if let item {
                VStack(alignment: .leading, spacing: ShannonSpacing.extraLarge) {
                    detailHeader(item, palette)
                    if let confidence = item.confidence { confidenceCard(confidence, palette) }
                    if let disclosure = item.disclosure { disclosureCard(item, disclosure, palette) }
                    evidenceSection(item, palette)
                    historySection(item, palette)
                    actions(item, palette)
                    if let error = model.errorMessage {
                        MemoryErrorCard(message: error, palette: palette) { model.dismissError() }
                    }
                }
                .padding(ShannonSpacing.large)
            } else {
                ContentUnavailableView("記憶が見つかりません", systemImage: "questionmark.folder")
                    .padding(.top, 80)
            }
        }
        .background(palette.readingSurface)
        .navigationTitle("記憶の詳細")
        .sheet(isPresented: $showsCorrection) {
            correctionSheet(palette)
        }
        .confirmationDialog("この記憶をどう扱いますか？", isPresented: Binding(
            get: { destructiveAction != nil }, set: { if !$0 { destructiveAction = nil } }
        ), titleVisibility: .visible) {
            if destructiveAction == .forget {
                Button("忘れる", role: .destructive) { perform(.forget) }
            } else if destructiveAction == .reject {
                Button("事実ではないと記録", role: .destructive) { perform(.reject) }
            }
            Button("キャンセル", role: .cancel) { destructiveAction = nil }
        } message: {
            Text(destructiveAction == .reject ? ShannonMemoryWithholdingCopy.reject : ShannonMemoryWithholdingCopy.forget)
        }
    }

    func detailHeader(_ item: ShannonMemoryItemDTO, _ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label(item.kind.japaneseName, systemImage: item.kind.symbolName)
                .font(.shannon(.callout).weight(.semibold))
                .foregroundStyle(palette.action)
            Text(item.text)
                .font(.shannon(.title2).weight(.semibold))
                .textSelection(.enabled)
            if let commitment = item.commitment {
                Label(commitment.statusLabel, systemImage: "calendar.badge.clock")
                    .font(.shannon(.callout).weight(.medium))
                Text("期限：\(commitment.dueAt.map(displayDate) ?? commitment.dueDate ?? commitment.dueHint ?? "未定")")
                    .font(.shannon(.callout)).foregroundStyle(palette.textSecondary)
            }
            if item.status != .active {
                Label(item.status == .rejected ? "事実ではないと指定済み" : "忘れるよう指定済み",
                      systemImage: item.status == .rejected ? "xmark.seal.fill" : "eye.slash.fill")
                    .font(.shannon(.callout).weight(.medium))
                    .foregroundStyle(palette.danger)
                Text(ShannonMemoryWithholdingCopy.restore)
                    .font(.shannon(.footnote)).foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(ShannonSpacing.extraLarge)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
    }

    func confidenceCard(_ value: Double, _ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            HStack {
                Text("確信度").font(.shannon(.headline))
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.shannon(.headline).monospacedDigit())
            }
            ProgressView(value: value).tint(palette.action)
            Text("同じ内容が会話で再確認されると上がります。矛盾した時は自動で上書きしません。")
                .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
    }

    func evidenceSection(_ item: ShannonMemoryItemDTO, _ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Text("そう思った根拠").font(.shannon(.title3).weight(.semibold))
            if item.evidence.isEmpty {
                Text("直接の引用は残っていません。")
                    .foregroundStyle(palette.textSecondary)
            } else {
                ForEach(Array(item.evidence.enumerated()), id: \.offset) { _, evidence in
                    VStack(alignment: .leading, spacing: 7) {
                        Text("“\(evidence.quote)”")
                            .font(.shannon(.body)).italic().textSelection(.enabled)
                        Text("\(sourceName(evidence.source))・\(displayDate(evidence.observedAt))")
                            .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    }
                    .padding(ShannonSpacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.subtleSurface.opacity(0.7), in: RoundedRectangle(cornerRadius: ShannonShape.large))
                }
            }
        }
    }

    func historySection(_ item: ShannonMemoryItemDTO, _ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Text("この記憶の履歴").font(.shannon(.title3).weight(.semibold))
            LabeledContent("覚えた日", value: displayDate(item.createdAt))
            LabeledContent("最後の変化", value: displayDate(item.updatedAt))
            LabeledContent("変わった理由", value: item.changeReason)
        }
        .font(.shannon(.body))
        .padding(ShannonSpacing.large)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
    }

    func actions(_ item: ShannonMemoryItemDTO, _ palette: ShannonPalette) -> some View {
        VStack(spacing: ShannonSpacing.small) {
            if item.status == .active {
                if item.commitment?.status == "pending" {
                    actionButton("約束を完了にする", symbol: "checkmark.circle", palette: palette) { perform(.complete) }
                    actionButton("約束を取り消す", symbol: "calendar.badge.minus", palette: palette) { perform(.dismiss) }
                }
                actionButton(item.pinned ? "固定を外す" : "大切な記憶として固定",
                             symbol: item.pinned ? "pin.slash" : "pin.fill", palette: palette) {
                    perform(item.pinned ? .unpin : .pin)
                }
                actionButton("内容を訂正", symbol: "pencil", palette: palette) {
                    correction = item.text
                    showsCorrection = true
                }
                actionButton("この記憶を忘れる", symbol: "eye.slash", palette: palette, destructive: true) {
                    destructiveAction = .forget
                }
                actionButton("これは事実ではない", symbol: "xmark.seal", palette: palette, destructive: true) {
                    destructiveAction = .reject
                }
            } else {
                actionButton("この記憶を復元", symbol: "arrow.uturn.backward", palette: palette) {
                    perform(.restore)
                }
            }
        }
        .disabled(model.mutatingMemoryID != nil)
    }

    func actionButton(
        _ title: String, symbol: String, palette: ShannonPalette, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: symbol).frame(width: 28)
                Text(title).font(.shannon(.body).weight(.medium))
                Spacer()
                if model.mutatingMemoryID == memoryID { ProgressView().controlSize(.small) }
            }
            .foregroundStyle(destructive ? palette.danger : palette.action)
            .padding(.horizontal, ShannonSpacing.large)
            .frame(minHeight: 56)
            .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        }
        .buttonStyle(.plain)
    }

    func correctionSheet(_ palette: ShannonPalette) -> some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                Text(ShannonMemoryWithholdingCopy.correct)
                    .font(.shannon(.body)).foregroundStyle(palette.textSecondary)
                TextEditor(text: $correction)
                    .padding(ShannonSpacing.medium)
                    .frame(minHeight: 150)
                    .background(palette.elevatedSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large))
                Spacer()
            }
            .padding(ShannonSpacing.large)
            .background(palette.canvas)
            .navigationTitle("記憶を訂正")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { showsCorrection = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        guard let item else { return }
                        Task {
                            if await model.act(on: item, action: .correct, text: correction) { showsCorrection = false }
                        }
                    }
                    .disabled(correction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    func perform(_ action: ShannonMemoryActionDTO) {
        destructiveAction = nil
        guard let item else { return }
        Task { _ = await model.act(on: item, action: action) }
    }
}
