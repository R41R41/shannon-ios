import SwiftUI

struct ShannonTaskTreeEditor: View {
    let tree: ShannonTaskTreeDTO
    @Bindable var model: ShannonTaskTreeModel
    @State private var change: ShannonTaskTreeChangeDTO
    @State private var hasDeadline: Bool
    @State private var deadline: Date
    @Environment(\.dismiss) private var dismiss
    init(tree: ShannonTaskTreeDTO, model: ShannonTaskTreeModel) {
        self.tree = tree; self.model = model
        _change = State(initialValue: ShannonTaskTreeChangeDTO(tree: tree))
        _hasDeadline = State(initialValue: tree.deadline != nil)
        _deadline = State(initialValue: tree.deadline.flatMap { try? Date($0, strategy: .iso8601) } ?? Date())
    }
    var body: some View {
        NavigationStack {
          Group {
            if model.hidden || model.othersPresent { Text("この作業の条件はいま表示しません。") } else {
            Form {
                Section("目的と内容") {
                    TextField("目的", text: $change.goal, axis: .vertical)
                    TextField("内容", text: $change.content, axis: .vertical)
                    Toggle("期限を決める", isOn: $hasDeadline)
                    if hasDeadline { DatePicker("期限", selection: $deadline) }
                }
                if let rootIndex = change.nodes.firstIndex(where: { $0.id == tree.rootId }) {
                    Section("元の完了条件") {
                        if change.nodes[rootIndex].contract == nil {
                            Text("完了条件はまだありません。過去の結果を完了の根拠にしません。")
                            Button("完了条件を設定する") {
                                change.nodes[rootIndex].contract = ShannonTaskFinishContractDTO(result: change.goal,
                                    checks: [], constraints: [], boundary: [], stop: [])
                            }
                        } else {
                            contractFields(rootIndex)
                        }
                    }
                }
                Section {
                    ForEach(change.nodes.indices, id: \.self) { index in
                        TextField(change.nodes[index].id == tree.rootId ? "元の作業" : "工程", text: $change.nodes[index].title, axis: .vertical)
                    }
                    Button("工程を加える") {
                        let root = change.nodes.first { $0.id == tree.rootId }
                        change.nodes.append(.init(id: UUID().uuidString.lowercased(), parentId: tree.rootId,
                            order: min(100, change.nodes.count), dependsOn: [], title: "新しい工程", contract: root?.contract))
                    }.disabled(change.nodes.count >= 100)
                } header: { Text("工程") } footer: { Text("元の完了条件・守ること・範囲・停止条件を、加えた工程にも引き継ぎます。") }
                if let notice = model.notice { Section { Text(notice) } }
                Section {
                    Button("変更案を保存する") {
                        var proposed = change
                        proposed.deadline = hasDeadline ? deadline.ISO8601Format() : nil
                        proposed.inheritRootChanges(from: tree)
                        Task {
                            await model.propose(proposed)
                            if model.pending == nil && model.notice == nil { dismiss() }
                        }
                    }.disabled(!valid || !model.fresh || model.pending != nil)
                    if model.pending != nil { Button("届いたか確認する") { Task { await model.reload() } } }
                } footer: { Text("保存した案は、変更前と変更後を読んでから採用します。ここではまだ作業の条件は変わりません。") }
            }
            }
          }
            .navigationTitle("条件の変更案")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
    }
    private var valid: Bool {
        !change.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !change.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && change.nodes.allSatisfy { !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            && change.nodes.compactMap(\.contract).allSatisfy {
                !$0.result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && $0.checks.allSatisfy { !$0.target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            }
    }
    @ViewBuilder private func contractFields(_ index: Int) -> some View {
        TextField("完了したときの状態", text: Binding(get: { change.nodes[index].contract?.result ?? "" },
            set: { change.nodes[index].contract?.result = $0 }), axis: .vertical)
        if let checks = change.nodes[index].contract?.checks {
            ForEach(checks.indices, id: \.self) { checkIndex in
                TextField("完了を確かめること", text: Binding(get: { change.nodes[index].contract?.checks[checkIndex].target ?? "" },
                    set: { change.nodes[index].contract?.checks[checkIndex].target = $0 }), axis: .vertical)
            }
            Menu("確認することを加える") {
                Button("テスト") { addCheck(index, kind: "test") }
                Button("ファイル") { addCheck(index, kind: "file") }
                Button("結果の記録") { addCheck(index, kind: "receipt") }
            }.disabled(checks.count >= 32)
        }
        TextField("守ること（1行に1件）", text: lines(index, keyPath: \.constraints), axis: .vertical)
        TextField("作業してよい範囲（1行に1件）", text: lines(index, keyPath: \.boundary), axis: .vertical)
        TextField("止める条件（1行に1件）", text: lines(index, keyPath: \.stop), axis: .vertical)
    }
    private func addCheck(_ index: Int, kind: String) {
        change.nodes[index].contract?.checks.append(.init(id: UUID().uuidString.lowercased(), kind: kind, target: ""))
    }
    private func lines(_ index: Int, keyPath: WritableKeyPath<ShannonTaskFinishContractDTO, [String]>) -> Binding<String> {
        Binding(get: { change.nodes[index].contract?[keyPath: keyPath].joined(separator: "\n") ?? "" }, set: { value in
            change.nodes[index].contract?[keyPath: keyPath] = value.split(separator: "\n").map(String.init)
        })
    }
}

extension ShannonTaskTreeChangeDTO {
    /// Replace only inherited root conditions; preserve each existing child's extra restrictions and checks.
    mutating func inheritRootChanges(from tree: ShannonTaskTreeDTO) {
        guard let root = nodes.first(where: { $0.id == tree.rootId })?.contract else { return }
        let old = tree.nodes.first(where: { $0.id == tree.rootId })?.contract
        for index in nodes.indices where nodes[index].id != tree.rootId {
            let child = nodes[index].contract
            let checks = child?.checks.filter { !(old?.checks.contains($0) ?? false) } ?? []
            let constraints = child?.constraints.filter { !(old?.constraints.contains($0) ?? false) } ?? []
            let boundary = child?.boundary.filter { !(old?.boundary.contains($0) ?? false) } ?? []
            let stop = child?.stop.filter { !(old?.stop.contains($0) ?? false) } ?? []
            nodes[index].contract = ShannonTaskFinishContractDTO(result: root.result,
                checks: root.checks + checks.filter { check in !root.checks.contains { $0.id == check.id } },
                constraints: Array(Set(root.constraints + constraints)).sorted(),
                boundary: Array(Set(root.boundary + boundary)).sorted(), stop: Array(Set(root.stop + stop)).sorted())
        }
    }
}
