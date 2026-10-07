import SwiftUI

struct ShannonInterestDetailView: View {
    let id: String
    @Bindable var model: ShannonInterestsModel
    @State private var confirmation: InterestConfirmation?
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Group {
        if let item = model.item(id), !model.hidden {
            List {
                ShannonInterestOperationNotice(model: model)
                Section {
                    Text(item.description)
                    Text(item.reason).foregroundStyle(palette.textSecondary)
                    if let weight = item.weight { LabeledContent("関心の重み", value: weight.formatted(.number.precision(.fractionLength(2)))) }
                    Text("参考にした記録：\(item.evidenceRefs?.count ?? 0)件").font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    status(item, palette: palette)
                }
                Section("この関心の扱い") {
                    control(item, item.pinned ? .unpin : .pin, item.pinned ? "固定を外す" : "固定する")
                    control(item, item.banned ? .unban : .ban, item.banned ? "禁止を解除する" : "この関心を禁止する")
                    if !item.forgotten { control(item, .forget, "この関心を忘れる") }
                    if item.frozen && !item.banned && !item.forgotten { control(item, .resume, "自動更新を再開する") }
                }
                Section("参考にした記録") {
                    if let evidence = model.details[id]?.evidence, evidence.status == "available" {
                        ForEach(evidence.items) { record in
                            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                                Text(record.text)
                                if record.truncated { Text("記録の一部を表示しています。").font(.shannon(.caption)).foregroundStyle(palette.textSecondary) }
                            }
                        }
                        if evidence.omitted > 0 { Text("ほか\(evidence.omitted)件の記録を参考にしています。").foregroundStyle(palette.textSecondary) }
                        if evidence.items.isEmpty { Text("参考にした記録はありません。") }
                    } else {
                        Text(model.details[id]?.evidence?.status == "hidden" ? "この記録は表示しません。" : "参考にした記録は、いま確認できません。")
                            .foregroundStyle(palette.textSecondary)
                    }
                }
                Section("見直しの記録") {
                    ForEach(model.details[id]?.changes ?? model.changes.filter { $0.itemId == id }) { change in
                        NavigationLink(change.reason) { ShannonInterestChangeView(selected: change, model: model) }
                    }
                }
                if let cursor = model.details[id]?.nextCursor { Button("前の記録を読む") { Task { await model.loadDetail(id, cursor: cursor) } } }
            }.navigationTitle(item.title).tint(palette.action).task(id: item.revision) { await model.loadDetail(id) }

        } else { Text("この関心は表示できません。") }
        }.modifier(InterestConfirmationModifier(model: model, confirmation: $confirmation))
    }
    func control(_ item: ShannonInterestDTO, _ action: ShannonInterestAction, _ title: String) -> some View {
        Button(title) {
            let message = switch action {
            case .ban: "この関心は自動で加え直されなくなります。禁止はあとから解除できます。"
            case .unban: "この関心の禁止を解除します。"
            case .forget: "この関心と、その内容を含む見直しの記録を表示しなくなります。自動で加え直されません。"
            case .resume: "次の朝から、この関心を自動で見直せるようにします。"
            default: action == .pin ? "この関心を朝の見直しで変えないようにします。" : "この関心の固定を外します。"
            }
            confirmation = InterestConfirmation(item: item, action: action, changeID: nil, title: title, message: message)
        }.disabled(model.pending != nil || !model.fresh || item.forgotten)
            .frame(minHeight: ShannonTouchTarget.minimum)
    }
    func status(_ item: ShannonInterestDTO, palette: ShannonPalette) -> some View {
        let labels = [item.pinned ? "固定" : nil, item.banned ? "禁止" : nil,
                      item.forgotten ? "忘れています" : nil, item.frozen ? "自動更新は停止中" : nil].compactMap { $0 }
        return Text(labels.joined(separator: "・")).font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
    }
    func date(_ value: String) -> String {
        (try? Date(value, strategy: .iso8601)).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "日時不明"
    }
}

struct ShannonInterestChangeView: View {
    let selected: ShannonInterestChangeDTO
    @Bindable var model: ShannonInterestsModel
    @State private var confirmation: InterestConfirmation?
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Group {
        if let change = (model.details[selected.itemId]?.changes ?? model.changes).first(where: { $0.id == selected.id }), !model.hidden {
          List {
            ShannonInterestOperationNotice(model: model)
            Section("見直した理由") { Text(change.reason); Text(date(change.createdAt)).foregroundStyle(palette.textSecondary) }
            Section("見直す前") { Text(change.before?.description ?? "新しく加えた関心です") }
            Section("見直した後") { Text(change.after.description) }
            if let item = model.item(change.itemId), !item.forgotten {
                Section {
                    if change.actor == "sleep", !item.banned {
                        Button("この変更を戻す") {
                            confirmation = InterestConfirmation(item: item, action: .undo, changeID: change.changeId,
                                title: "この変更を戻す", message: "この変更だけを戻し、この関心の自動更新を止めます。ほかの関心はそのまま残ります。")
                        }.disabled(model.pending != nil || !model.fresh)
                    }
                    control(item, item.pinned ? .unpin : .pin, item.pinned ? "固定を外す" : "固定する")
                    control(item, item.banned ? .unban : .ban, item.banned ? "禁止を解除する" : "この関心を禁止する")
                    NavigationLink("この関心の詳細") { ShannonInterestDetailView(id: item.id, model: model) }
                }
            }
          }.navigationTitle(change.after.title).tint(palette.action)

        } else { Text("この変更は表示できません。最新の記録を読み直してください。") }
        }.modifier(InterestConfirmationModifier(model: model, confirmation: $confirmation))
    }
    func control(_ item: ShannonInterestDTO, _ action: ShannonInterestAction, _ title: String) -> some View {
        Button(title) {
            let message = switch action {
            case .ban: "この関心は自動で加え直されなくなります。禁止はあとから解除できます。"
            case .unban: "この関心の禁止を解除します。"
            case .forget: "この関心と、その内容を含む見直しの記録を表示しなくなります。自動で加え直されません。"
            case .resume: "次の朝から、この関心を自動で見直せるようにします。"
            default: action == .pin ? "この関心を朝の見直しで変えないようにします。" : "この関心の固定を外します。"
            }
            confirmation = InterestConfirmation(item: item, action: action, changeID: nil, title: title, message: message)
        }.disabled(model.pending != nil || !model.fresh || item.forgotten)
            .frame(minHeight: ShannonTouchTarget.minimum)
    }
    func status(_ item: ShannonInterestDTO, palette: ShannonPalette) -> some View {
        let labels = [item.pinned ? "固定" : nil, item.banned ? "禁止" : nil,
                      item.forgotten ? "忘れています" : nil, item.frozen ? "自動更新は停止中" : nil].compactMap { $0 }
        return Text(labels.joined(separator: "・")).font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
    }
    func date(_ value: String) -> String {
        (try? Date(value, strategy: .iso8601)).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "日時不明"
    }
}

struct InterestConfirmation {
        let item: ShannonInterestDTO; let action: ShannonInterestAction; let changeID: String?; let title: String; let message: String
    }

/// Presentation belongs to the visible destination, so navigating forward never queues a sheet on its inactive parent.
private struct InterestConfirmationModifier: ViewModifier {
    @Bindable var model: ShannonInterestsModel
    @Binding var confirmation: InterestConfirmation?
    func body(content: Content) -> some View {
        content.confirmationDialog(confirmation?.title ?? "", isPresented: Binding(
            get: { confirmation != nil && !model.hidden }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
            if let confirmation {
                Button(confirmation.title, role: confirmation.action == .ban || confirmation.action == .forget ? .destructive : nil) {
                    self.confirmation = nil
                    Task { await model.perform(item: confirmation.item, action: confirmation.action, changeID: confirmation.changeID) }
                }
            }
            Button("戻る", role: .cancel) { confirmation = nil }
        } message: { Text(confirmation?.message ?? "") }
        .onChange(of: model.hidden) { _, hidden in if hidden { confirmation = nil } }
    }
}

struct ShannonInterestOperationNotice: View {
    @Bindable var model: ShannonInterestsModel
    var body: some View {
        if let notice = model.notice, !model.hidden {
            Section {
                Text(notice).foregroundStyle(.secondary)
                Button(model.pending != nil ? "届いたか確認する" : "読み直す") { Task { await model.checkPending() } }
                    .disabled(model.pending?.checking == false).frame(minHeight: ShannonTouchTarget.minimum)
            }
        }
    }
}
