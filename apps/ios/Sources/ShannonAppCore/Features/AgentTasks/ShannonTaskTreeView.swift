import SwiftUI

/// Extra detail inside the existing 作業 room/inspector, without replacing its live controls and reports.
public struct ShannonTaskTreeView: View {
    @Bindable var model: ShannonTaskTreeModel
    @State private var showsEditor = false
    @State private var selectedProposal: ShannonTaskTreeProposalDTO?
    @Environment(\.colorScheme) private var colorScheme
    public init(model: ShannonTaskTreeModel) { self.model = model }
    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(alignment: .leading, spacing: 0) {
            if let read = model.read, !model.hidden {
                VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                    Label("作業の条件と道筋", systemImage: "list.bullet.indent").font(.shannon(.headline))
                    Text(read.tree.goal).font(.shannon(.body))
                    Text(read.tree.content).font(.shannon(.callout)).foregroundStyle(palette.textSecondary)
                    if let deadline = read.tree.deadline { Text("期限：\(formatted(deadline))").font(.shannon(.callout)) }
                    Text(read.tree.origin == "owner_request" ? "あなたの依頼" : read.tree.origin == "own_time" ? "自分の時間" : "由来は未確認")
                        .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    ForEach(ordered(read.tree)) { entry in
                        DisclosureGroup {
                            if let contract = entry.node.contract { ShannonTaskContractView(contract: contract) }
                            else { Text("完了条件はまだ設定されていません。").foregroundStyle(palette.textSecondary) }
                            if !entry.node.dependsOn.isEmpty {
                                let names = entry.node.dependsOn.compactMap { id in read.tree.nodes.first { $0.id == id }?.title }
                                Text("この工程の後に進めます：\(names.joined(separator: "、"))").font(.shannon(.caption))
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                                Text(entry.node.title)
                                Label(state(entry.node.state), systemImage: symbol(entry.node.state))
                                    .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                            }
                        }.padding(.leading, CGFloat(entry.depth) * ShannonSpacing.medium)
                    }
                    DisclosureGroup("確認された根拠") {
                        if read.verification?.status == "verified" {
                            Text("保存された実行結果と、完了条件が一致しています。")
                            Text("確認された記録：\(read.verification?.evidenceIds?.count ?? 0)件").font(.shannon(.caption))
                        } else {
                            Text(read.verification?.status == "unknown" ? "実行結果を確認できていません。" : "完了を確かめる根拠は、まだ揃っていません。")
                        }
                    }
                    if read.tree.origin == "owner_request" {
                        Button("条件の変更案を作る") { showsEditor = true }
                            .disabled(!model.fresh || model.pending != nil)
                    }
                    ForEach(model.proposals.filter { $0.state == "proposed" }) { proposal in
                        Button("条件の変更案を見る") { selectedProposal = proposal }
                            .frame(minHeight: ShannonTouchTarget.minimum)
                    }
                    if let notice = model.notice {
                        Text(notice).font(.shannon(.callout)).foregroundStyle(palette.textSecondary)
                        Button(model.pending != nil ? "届いたか確認する" : "読み直す") { Task { await model.reload() } }
                    }
                }
                .padding(ShannonSpacing.medium)
                .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
                .tint(palette.action)
            } else if model.isLoading {
                ProgressView("作業の条件を確認しています…")
            } else if model.showsInitialReadError, let notice = model.notice {
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    Text(notice).font(.shannon(.callout)).foregroundStyle(palette.textSecondary)
                    Button("読み直す") { Task { await model.reload() } }
                        .frame(minHeight: ShannonTouchTarget.minimum)
                }
                .accessibilityIdentifier("task-tree-initial-read-error")
            }
        }
        .task(id: ReadIdentity(model: ObjectIdentifier(model), othersPresent: model.othersPresent)) {
            if !model.othersPresent { await model.reload() }
        }
        .onChange(of: ObjectIdentifier(model)) { _, _ in
            showsEditor = false
            selectedProposal = nil
        }
        .sheet(isPresented: $showsEditor) {
            if let tree = model.read?.tree { ShannonTaskTreeEditor(tree: tree, model: model) }
        }
        .onChange(of: model.isAdoptionConfirmed(selectedProposal)) { _, confirmed in
            if confirmed { selectedProposal = nil }
        }
        .sheet(item: $selectedProposal) { proposal in
            NavigationStack {
                ShannonTaskTreeProposalView(proposal: proposal, model: model)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { selectedProposal = nil } } }
            }
#if os(macOS)
            .frame(minWidth: 520, minHeight: 600)
#endif
        }
    }
    private struct ReadIdentity: Hashable { let model: ObjectIdentifier; let othersPresent: Bool }
    private struct Entry: Identifiable { let node: ShannonTaskTreeNodeDTO; let depth: Int; var id: String { node.id } }
    private func ordered(_ tree: ShannonTaskTreeDTO) -> [Entry] {
        var result: [Entry] = []; var visited: Set<String> = []
        func walk(_ id: String, depth: Int) {
            guard depth < 100, visited.insert(id).inserted, let node = tree.nodes.first(where: { $0.id == id }) else { return }
            result.append(Entry(node: node, depth: depth))
            for child in tree.nodes.filter({ $0.parentId == id }).sorted(by: { $0.order < $1.order }) { walk(child.id, depth: depth + 1) }
        }
        walk(tree.rootId, depth: 0)
        return result
    }
    private func state(_ value: String) -> String {
        switch value { case "done": "確認済み"; case "continue": "続けています"; case "blocked": "止まっています"; default: "確認待ち" }
    }
    private func symbol(_ value: String) -> String {
        switch value { case "done": "checkmark.circle"; case "continue": "arrow.right.circle"; case "blocked": "pause.circle"; default: "clock" }
    }
    private func formatted(_ value: String) -> String {
        (try? Date(value, strategy: .iso8601)).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "日時未確認"
    }
}

struct ShannonTaskContractView: View {
    let contract: ShannonTaskFinishContractDTO
    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Text("完了したときの状態").font(.shannon(.caption).weight(.semibold))
            Text(contract.result)
            if !contract.checks.isEmpty {
                Text("完了を確かめること").font(.shannon(.caption).weight(.semibold))
                ForEach(contract.checks) { check in Text("・\(check.target)") }
            }
            lines("守ること", contract.constraints)
            lines("作業してよい範囲", contract.boundary)
            lines("止める条件", contract.stop)
        }.font(.shannon(.callout)).padding(.vertical, ShannonSpacing.small)
    }
    @ViewBuilder private func lines(_ title: String, _ values: [String]) -> some View {
        if !values.isEmpty {
            Text(title).font(.shannon(.caption).weight(.semibold))
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in Text("・\(value)") }
        }
    }
}

struct ShannonTaskTreeProposalView: View {
    let proposal: ShannonTaskTreeProposalDTO
    @Bindable var model: ShannonTaskTreeModel
    @State private var confirms = false
    var body: some View {
      Group {
        if model.hidden || model.othersPresent { Text("この変更案はいま表示しません。") } else {
        List {
            Section("目的の変更") {
                Text("いま：\(model.read?.tree.goal ?? "読み込み中")")
                Text("変更後：\(proposal.change.goal)")
            }
            Section("内容の変更") {
                Text("いま：\(model.read?.tree.content ?? "読み込み中")")
                Text("変更後：\(proposal.change.content)")
                Text("期限：\(model.read?.tree.deadline ?? "なし") → \(proposal.change.deadline ?? "なし")")
            }
            ForEach(proposal.change.nodes) { node in
                Section(node.title) {
                    if let old = model.read?.tree.nodes.first(where: { $0.id == node.id })?.contract, old != node.contract {
                        DisclosureGroup("いまの条件") { ShannonTaskContractView(contract: old) }
                    }
                    if let contract = node.contract { ShannonTaskContractView(contract: contract) }
                    else { Text("完了条件は未設定") }
                }
            }
            Section {
                if model.read?.tree.revision != proposal.expectedRevision {
                    Text("この案の後に作業が更新されました。最新の内容から案を作り直してください。")
                }
                if let notice = model.notice { Text(notice) }
                Button("この変更を採用する") { confirms = true }
                    .disabled(!model.fresh || model.pending != nil || proposal.state != "proposed" || model.read?.tree.revision != proposal.expectedRevision)
                if model.pending != nil { Button("届いたか確認する") { Task { await model.reload() } } }
            }
        }
        }
      }.navigationTitle("条件の変更案")
            .confirmationDialog("この変更を採用しますか？", isPresented: $confirms, titleVisibility: .visible) {
                Button("この変更を採用する") { Task { await model.approve(proposal) } }
                Button("戻る", role: .cancel) {}
            } message: { Text("表示した目的・内容・期限・条件に変更します。実行の許可は別に確認します。") }
    }
}
