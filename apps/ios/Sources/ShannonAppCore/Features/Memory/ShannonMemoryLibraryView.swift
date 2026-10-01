import SwiftUI

struct ShannonMemoryLibraryView: View {
    @Bindable var model: ShannonMemoryModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let library = ShannonMemoryLibrary(dashboard: model.dashboard)
        List {
            if model.isLoading && model.dashboard == nil {
                ProgressView("記憶を読み込み中…")
            }
            ForEach(ShannonMemoryLibrary.SectionID.allCases) { section in
                Section(section.title) {
                    let items = library.items(in: section)
                    if items.isEmpty {
                        Text(section.emptyMessage)
                            .foregroundStyle(palette.textSecondary)
                    } else {
                        ForEach(items) { item in
                            NavigationLink {
                                ShannonMemoryDetailView(model: model, memoryID: item.id)
                            } label: {
                                ShannonMemoryLibraryRow(item: item, palette: palette)
                            }
                            .accessibilityIdentifier("memory-library-item-\(item.id)")
                        }
                    }
                    if section == .hidden {
                        Text(ShannonMemoryWithholdingCopy.hiddenList)
                            .font(.caption)
                            .foregroundStyle(palette.textSecondary)
                    }
                }
            }
            if let error = model.errorMessage {
                MemoryErrorCard(message: error, palette: palette) {
                    Task { await model.reload() }
                }
            }
        }
        .navigationTitle("記憶と約束")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await model.reload() } } label: {
                    Label("記憶を更新", systemImage: "arrow.clockwise")
                }
                .disabled(model.isLoading || model.mutatingMemoryID != nil)
            }
        }
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
    }
}

struct ShannonMemoryLibraryRow: View {
    let item: ShannonMemoryItemDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            Text(item.text)
                .font(.body)
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if item.status != .active {
                Label(item.status == .rejected ? "事実ではないと指定済み" : "会話に使わない記憶",
                      systemImage: item.status == .rejected ? "xmark.seal" : "eye.slash")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            } else if let commitment = item.commitment {
                Label(commitment.statusLabel, systemImage: "calendar.badge.clock")
                    .font(.caption)
                    .foregroundStyle(palette.action)
                Text("期限：\(commitment.dueAt.map(displayDate) ?? commitment.dueDate ?? commitment.dueHint ?? "未定")")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            } else {
                Label(item.kind.japaneseName, systemImage: item.kind.symbolName)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }
        }
        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct ShannonMemoryManagementLabel: View {
    let summary: String
    let palette: ShannonPalette

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: "tray.full")
                .foregroundStyle(palette.action)
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text("記憶と約束")
                    .font(.headline)
                    .foregroundStyle(palette.textPrimary)
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                Text("内容の訂正・完了・取り消し・復元")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .accessibilityElement(children: .combine)
    }
}
