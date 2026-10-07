import SwiftUI

struct ShannonInterestsView: View {
    @Bindable var model: ShannonInterestsModel
    @State private var confirmation: InterestConfirmation?
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if model.isLoading && model.snapshot == nil { ProgressView("関心を読み込んでいます…") }
            if model.hidden { Text("この端末では関心を表示できません。").foregroundStyle(palette.textSecondary) }
            if let notice = model.notice {
                Section {
                    Text(notice).foregroundStyle(palette.textSecondary)
                    Button(model.pending != nil ? "届いたか確認する" : "読み直す") {
                        Task { await model.checkPending() }
                    }.disabled(model.pending?.checking == false)
                }
            }
            if let snapshot = model.snapshot, !model.hidden {
                Section {
                    ForEach(snapshot.items.filter(\.active)) { item in
                        NavigationLink { ShannonInterestDetailView(id: item.id, model: model, confirmation: $confirmation) } label: {
                            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                                Text(item.title)
                                status(item, palette: palette)
                            }
                        }
                    }
                    if snapshot.items.filter(\.active).isEmpty { Text("いまの関心はありません").foregroundStyle(palette.textSecondary) }
                } header: { Text("いまの関心（\(snapshot.capacity.used)／\(snapshot.capacity.limit)）") }
                Section {
                    ForEach(model.changes) { change in
                        NavigationLink { ShannonInterestChangeView(selected: change, model: model, confirmation: $confirmation) } label: {
                            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                                Text(change.after.title)
                                Text(change.reason).font(.shannon(.callout)).foregroundStyle(palette.textSecondary)
                                Text("\(date(change.createdAt))・\(change.actor == "sleep" ? "朝の見直し" : "あなたの操作")")
                                    .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                            }
                        }
                    }
                    if model.changes.isEmpty { Text("まだ見直しの記録はありません").foregroundStyle(palette.textSecondary) }
                    if let cursor = snapshot.nextCursor {
                        Button("前の記録を読む") { Task { await model.reload(cursor: cursor) } }.disabled(model.isLoading)
                    }
                } header: { Text("関心の日記") }
                let paused = snapshot.items.filter { !$0.active }
                if !paused.isEmpty {
                    Section("休んでいる関心") {
                        ForEach(paused) { item in NavigationLink(item.title) { ShannonInterestDetailView(id: item.id, model: model, confirmation: $confirmation) } }
                    }
                }
            }
        }
        .navigationTitle("関心の日記")
        .tint(palette.action)
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
        .confirmationDialog(confirmation?.title ?? "", isPresented: Binding(
            get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
            if let confirmation {
                Button(confirmation.title, role: confirmation.action == .ban || confirmation.action == .forget ? .destructive : nil) {
                    self.confirmation = nil
                    Task { await model.perform(item: confirmation.item, action: confirmation.action, changeID: confirmation.changeID) }
                }
            }
            Button("戻る", role: .cancel) { confirmation = nil }
        } message: { Text(confirmation?.message ?? "") }
    }

    private func date(_ value: String) -> String {
        (try? Date(value, strategy: .iso8601)).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "日時不明"
    }
    private func status(_ item: ShannonInterestDTO, palette: ShannonPalette) -> some View {
        let labels = [item.pinned ? "固定" : nil, item.banned ? "禁止" : nil,
                      item.forgotten ? "忘れています" : nil, item.frozen ? "自動更新は停止中" : nil].compactMap { $0 }
        return Text(labels.joined(separator: "・")).font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
    }
}
