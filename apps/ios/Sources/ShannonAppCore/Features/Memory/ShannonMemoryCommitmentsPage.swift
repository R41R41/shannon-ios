import SwiftUI

/// 約束と目的: durable intents (managed in ShannonCognitionView) and the
/// pending/closed commitments from the memory library, as a native list.
struct ShannonMemoryCommitmentsPage: View {
    @Bindable var model: ShannonMemoryModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let library = ShannonMemoryLibrary(dashboard: model.dashboard)
        let category = ShannonMemoryOverview.Category.commitments
        List {
            Section {
                NavigationLink {
                    ShannonCognitionView(model: model)
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("目的と認知履歴")
                                .foregroundStyle(palette.textPrimary)
                            Text(intentSummary)
                                .font(.shannon(.caption))
                                .foregroundStyle(palette.textSecondary)
                        }
                    } icon: {
                        Image(systemName: "target").foregroundStyle(palette.brandPresence)
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
                .accessibilityIdentifier("cognition-management-entry")
                ForEach(model.activeIntents + model.pausedIntents) { intent in
                    NavigationLink {
                        ShannonCognitionView(model: model)
                    } label: {
                        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                            Text(intent.title)
                                .foregroundStyle(palette.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                            Label(intent.status.japaneseName, systemImage: intent.status.symbolName)
                                .font(.shannon(.caption))
                                .foregroundStyle(intent.status == .active ? palette.action : palette.attention)
                        }
                        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                    .accessibilityHint("目的の確認・一時停止・完了・再開を開きます")
                }
                if let error = model.cognitionErrorMessage {
                    MemoryErrorCard(message: error, palette: palette) {
                        Task { await model.reload() }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            } header: {
                Text("続けている目的")
            } footer: {
                Text("目的の状態は、あなたが明示的に変えたときだけ変わります。")
            }

            if model.isLoading && model.dashboard == nil {
                ProgressView("約束を読み込み中…")
            }
            ForEach([ShannonMemoryLibrary.SectionID.pending, .closed]) { section in
                Section {
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
                        }
                    }
                } header: {
                    Text(section.title)
                } footer: {
                    if section == .pending {
                        Text(category.emptyMessage)
                    }
                }
            }
            if let error = model.errorMessage {
                Section {
                    MemoryErrorCard(message: error, palette: palette) {
                        Task { await model.reload() }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .navigationTitle(category.title)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
    }

    private var intentSummary: String {
        if model.isLoading && model.cognition == .empty { return "読み込み中…" }
        if model.cognitionErrorMessage != nil && model.cognition == .empty { return "読み込めませんでした。開いて再試行できます" }
        let active = model.activeIntents.count
        let paused = model.pausedIntents.count
        let closed = model.closedIntents.count
        return "継続中 \(active)件・一時停止 \(paused)件・完了/取り下げ \(closed)件"
    }
}
