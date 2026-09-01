import SwiftUI

public struct ShannonMemoryView: View {
    @State private var model: ShannonMemoryModel
    @State private var filter: MemoryFilter = .all
    private let showsDismissButton: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    public init(
        model: ShannonMemoryModel = ShannonMemoryModel(),
        showsDismissButton: Bool = true
    ) {
        _model = State(initialValue: model)
        self.showsDismissButton = showsDismissButton
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: M3Spacing.large) {
                    memoryHero(palette)
                    if let report = model.latestSleepReport {
                        NavigationLink {
                            ShannonSleepReportView(report: report)
                        } label: {
                            SleepSummaryCard(report: report, palette: palette)
                        }
                        .buttonStyle(.plain)
                    }
                    filterChips(palette)

                    if model.isLoading && model.dashboard == nil {
                        ProgressView("記憶をたどっている…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 64)
                    } else if filteredActiveItems.isEmpty {
                        emptyState(palette)
                    } else {
                        memorySection("いま覚えていること", items: filteredActiveItems, palette: palette)
                    }

                    if filter == .all && !model.hiddenItems.isEmpty {
                        memorySection("あなたが境界を決めた記憶", items: model.hiddenItems, palette: palette)
                    }

                    if let error = model.errorMessage {
                        MemoryErrorCard(message: error, palette: palette) {
                            Task { await model.reload() }
                        }
                    }
                }
                .padding(M3Spacing.large)
            }
            .background(palette.surfaceContainerLow)
            .navigationTitle("シャノンの記憶")
            .toolbar {
                if showsDismissButton {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("閉じる") { dismiss() }
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await model.reload() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(model.isLoading)
                    .accessibilityLabel("記憶を更新")
                }
            }
            .task { await model.loadIfNeeded() }
            .refreshable { await model.reload() }
        }
    }

    private var filteredActiveItems: [ShannonMemoryItemDTO] {
        guard let kind = filter.kind else { return model.activeItems }
        return model.activeItems.filter { $0.kind == kind }
    }

    private func memoryHero(_ palette: M3Palette) -> some View {
        HStack(alignment: .center, spacing: M3Spacing.large) {
            ShannonAvatarView(expression: .thinking, size: 72)
            VStack(alignment: .leading, spacing: 5) {
                Text("わたしが覚えていること")
                    .font(.title3.weight(.semibold))
                Text("根拠を見たり、違うことは直したりできるよ。")
                    .font(.subheadline)
                    .foregroundStyle(palette.onSurfaceVariant)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.primaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
    }

    private func filterChips(_ palette: M3Palette) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: M3Spacing.small) {
                ForEach(MemoryFilter.allCases) { option in
                    Button { filter = option } label: {
                        Label(option.title, systemImage: option.symbol)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(filter == option ? palette.onPrimary : palette.onSurfaceVariant)
                            .padding(.horizontal, M3Spacing.medium)
                            .frame(minHeight: 40)
                            .background(filter == option ? palette.primary : palette.surfaceContainerHigh, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func memorySection(
        _ title: String,
        items: [ShannonMemoryItemDTO],
        palette: M3Palette
    ) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Text(title)
                .font(.title3.weight(.semibold))
                .padding(.horizontal, M3Spacing.extraSmall)
            ForEach(items) { item in
                NavigationLink {
                    ShannonMemoryDetailView(model: model, memoryID: item.id)
                } label: {
                    MemoryCard(item: item, palette: palette)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func emptyState(_ palette: M3Palette) -> some View {
        ContentUnavailableView {
            Label("まだ記憶がないみたい", systemImage: filter.symbol)
        } description: {
            Text(filter == .all ? "会話を重ねると、ここに少しずつ現れます。" : "この種類の記憶はまだありません。")
        }
        .foregroundStyle(palette.onSurfaceVariant)
        .padding(.vertical, M3Spacing.huge)
    }
}

private enum MemoryFilter: String, CaseIterable, Identifiable {
    case all, userFact, interest, experience, relationship
    var id: String { rawValue }
    var kind: ShannonMemoryKindDTO? {
        switch self {
        case .all: nil
        case .userFact: .userFact
        case .interest: .interest
        case .experience: .experience
        case .relationship: .relationship
        }
    }
    var title: String { kind?.japaneseName ?? "すべて" }
    var symbol: String { kind?.symbolName ?? "square.grid.2x2" }
}

private struct MemoryCard: View {
    let item: ShannonMemoryItemDTO
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: item.kind.symbolName)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.primary)
                .frame(width: 44, height: 44)
                .background(palette.secondaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(item.kind.japaneseName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.primary)
                    if item.pinned { Image(systemName: "pin.fill").foregroundStyle(palette.tertiary) }
                    if item.status != .active {
                        Text(item.status == .rejected ? "事実ではない" : "忘れる")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(palette.errorContainer, in: Capsule())
                    }
                }
                Text(item.text)
                    .font(.body)
                    .foregroundStyle(item.status == .active ? palette.onSurface : palette.onSurfaceVariant)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                HStack {
                    Text(item.changeReason)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
            }
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.7), lineWidth: 0.7)
        }
    }
}

private struct SleepSummaryCard: View {
    let report: ShannonSleepReportDTO
    let palette: M3Palette

    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: "moon.stars.fill")
                .font(.system(size: 25))
                .foregroundStyle(palette.onPrimaryContainer)
                .frame(width: 52, height: 52)
                .background(palette.primaryContainer, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text("眠っている間に考えたこと")
                    .font(.headline)
                Text(sleepSummary(report))
                    .font(.subheadline)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }
}

private struct ShannonMemoryDetailView: View {
    @Bindable var model: ShannonMemoryModel
    let memoryID: String
    @State private var showsCorrection = false
    @State private var correction = ""
    @State private var destructiveAction: ShannonMemoryActionDTO?
    @Environment(\.colorScheme) private var colorScheme

    private var item: ShannonMemoryItemDTO? { model.dashboard?.items.first { $0.id == memoryID } }

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        ScrollView {
            if let item {
                VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                    detailHeader(item, palette)
                    if let confidence = item.confidence { confidenceCard(confidence, palette) }
                    evidenceSection(item, palette)
                    historySection(item, palette)
                    actions(item, palette)
                    if let error = model.errorMessage {
                        MemoryErrorCard(message: error, palette: palette) { model.dismissError() }
                    }
                }
                .padding(M3Spacing.large)
            } else {
                ContentUnavailableView("記憶が見つかりません", systemImage: "questionmark.folder")
                    .padding(.top, 80)
            }
        }
        .background(palette.surfaceContainerLow)
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
            Text(destructiveAction == .reject
                 ? "今後の睡眠バッチでも同じ内容を自動で覚え直しません。"
                 : "会話の生成には使われなくなります。あとから復元できます。")
        }
    }

    private func detailHeader(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(item.kind.japaneseName, systemImage: item.kind.symbolName)
                .font(.callout.weight(.semibold))
                .foregroundStyle(palette.primary)
            Text(item.text)
                .font(.title2.weight(.semibold))
                .textSelection(.enabled)
            if item.status != .active {
                Label(item.status == .rejected ? "事実ではないと指定済み" : "忘れるよう指定済み",
                      systemImage: item.status == .rejected ? "xmark.seal.fill" : "eye.slash.fill")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.error)
            }
        }
        .padding(M3Spacing.extraLarge)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
    }

    private func confidenceCard(_ value: Double, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.small) {
            HStack {
                Text("確信度").font(.headline)
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.headline.monospacedDigit())
            }
            ProgressView(value: value).tint(palette.primary)
            Text("同じ内容が会話で再確認されると上がります。矛盾した時は自動で上書きしません。")
                .font(.caption).foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }

    private func evidenceSection(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Text("そう思った根拠").font(.title3.weight(.semibold))
            if item.evidence.isEmpty {
                Text("直接の引用は残っていません。")
                    .foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(Array(item.evidence.enumerated()), id: \.offset) { _, evidence in
                    VStack(alignment: .leading, spacing: 7) {
                        Text("“\(evidence.quote)”")
                            .font(.body).italic().textSelection(.enabled)
                        Text("\(sourceName(evidence.source))・\(displayDate(evidence.observedAt))")
                            .font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.secondaryContainer.opacity(0.7), in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }

    private func historySection(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Text("この記憶の履歴").font(.title3.weight(.semibold))
            LabeledContent("覚えた日", value: displayDate(item.createdAt))
            LabeledContent("最後の変化", value: displayDate(item.updatedAt))
            LabeledContent("変わった理由", value: item.changeReason)
        }
        .font(.body)
        .padding(M3Spacing.large)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }

    private func actions(_ item: ShannonMemoryItemDTO, _ palette: M3Palette) -> some View {
        VStack(spacing: M3Spacing.small) {
            if item.status == .active {
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

    private func actionButton(
        _ title: String, symbol: String, palette: M3Palette, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: symbol).frame(width: 28)
                Text(title).font(.body.weight(.medium))
                Spacer()
                if model.mutatingMemoryID == memoryID { ProgressView().controlSize(.small) }
            }
            .foregroundStyle(destructive ? palette.error : palette.primary)
            .padding(.horizontal, M3Spacing.large)
            .frame(minHeight: 56)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        }
        .buttonStyle(.plain)
    }

    private func correctionSheet(_ palette: M3Palette) -> some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: M3Spacing.large) {
                Text("シャノンが覚える正しい内容を書いてください。元の根拠と訂正履歴は残ります。")
                    .font(.body).foregroundStyle(palette.onSurfaceVariant)
                TextEditor(text: $correction)
                    .padding(M3Spacing.medium)
                    .frame(minHeight: 150)
                    .background(palette.surfaceContainerHigh, in: RoundedRectangle(cornerRadius: M3Shape.large))
                Spacer()
            }
            .padding(M3Spacing.large)
            .background(palette.surface)
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

    private func perform(_ action: ShannonMemoryActionDTO) {
        destructiveAction = nil
        guard let item else { return }
        Task { _ = await model.act(on: item, action: action) }
    }
}

private struct ShannonSleepReportView: View {
    let report: ShannonSleepReportDTO
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("\(report.dayKey) の睡眠", systemImage: "moon.stars.fill")
                        .font(.title2.weight(.semibold))
                    Text("会話を振り返り、急いで結論にせず整理した結果です。")
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                .padding(M3Spacing.extraLarge)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.primaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                reportSection("新しく覚えたこと", symbol: "plus.circle.fill", changes: report.learned, palette: palette)
                reportSection("理解が深まったこと", symbol: "arrow.triangle.2.circlepath", changes: report.updated, palette: palette)
                reportSection("興味の変化", symbol: "sparkles", changes: report.interestChanges, palette: palette)
                contradictionSection(palette)
            }
            .padding(M3Spacing.large)
        }
        .background(palette.surfaceContainerLow)
        .navigationTitle("睡眠後の変化")
    }

    private func reportSection(
        _ title: String, symbol: String, changes: [ShannonSleepChangeDTO], palette: M3Palette
    ) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(title, systemImage: symbol).font(.title3.weight(.semibold))
            if changes.isEmpty {
                Text("今回はありません").foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(changes) { change in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(change.text).font(.body.weight(.medium))
                        Text(change.reason).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }

    private func contradictionSection(_ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label("矛盾として保留したこと", systemImage: "arrow.left.arrow.right.circle.fill")
                .font(.title3.weight(.semibold))
            if report.contradictions.isEmpty {
                Text("今回はありません").foregroundStyle(palette.onSurfaceVariant)
            } else {
                ForEach(report.contradictions) { conflict in
                    VStack(alignment: .leading, spacing: M3Spacing.small) {
                        Text("いまの理解").font(.caption.weight(.semibold)).foregroundStyle(palette.primary)
                        Text(conflict.currentText)
                        Divider()
                        Text("新しく見つけた表現").font(.caption.weight(.semibold)).foregroundStyle(palette.tertiary)
                        Text(conflict.candidateText)
                        Text(conflict.reason).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(M3Spacing.large)
                    .background(palette.tertiaryContainer, in: RoundedRectangle(cornerRadius: M3Shape.large))
                }
            }
        }
    }
}

private struct MemoryErrorCard: View {
    let message: String
    let palette: M3Palette
    let action: () -> Void
    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(palette.error)
            Text(message).font(.callout)
            Spacer()
            Button("再試行", action: action).font(.callout.weight(.semibold)).foregroundStyle(palette.primary)
        }
        .padding(M3Spacing.large)
        .background(palette.errorContainer, in: RoundedRectangle(cornerRadius: M3Shape.large))
    }
}

private func sleepSummary(_ report: ShannonSleepReportDTO) -> String {
    let changes = report.learned.count + report.updated.count + report.interestChanges.count
    if changes == 0 && report.contradictions.isEmpty { return "昨夜は大きな変化なし" }
    var parts: [String] = []
    if changes > 0 { parts.append("\(changes)件の理解が変化") }
    if !report.contradictions.isEmpty { parts.append("\(report.contradictions.count)件を矛盾として保留") }
    return parts.joined(separator: "・")
}

private func displayDate(_ value: String) -> String {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    let date = (try? fractional.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    return date?.formatted(date: .abbreviated, time: .shortened) ?? value
}

private func sourceName(_ value: String) -> String {
    switch value {
    case "conversation": "会話"
    case "sleep": "睡眠中の整理"
    case "user": "あなたの訂正"
    default: value
    }
}
