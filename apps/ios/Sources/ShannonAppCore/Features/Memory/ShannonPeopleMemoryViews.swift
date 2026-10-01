import SwiftUI

/// 頭の中 › 人: the people Shannon has met with the owner. A native list on iPhone and Mac.
struct ShannonPeopleListPage: View {
    @Bindable var model: ShannonMemoryModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let presentation = ShannonPeopleMemoryPresentation(people: model.people)
        List {
            if let error = model.peopleErrorMessage {
                Section {
                    MemoryErrorCard(message: error, palette: palette) { Task { await model.reloadPeople() } }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            if model.people == nil, model.peopleErrorMessage == nil {
                Section { ProgressView("読み込み中…").frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum) }
            } else if presentation.isEmpty {
                Section {
                    ContentUnavailableView(ShannonPeopleMemoryCopy.emptyTitle, systemImage: "person.2",
                        description: Text(ShannonPeopleMemoryCopy.emptyMessage))
                }
            } else {
                Section {
                    ForEach(presentation.rows) { person in
                        NavigationLink {
                            ShannonPersonDetailPage(model: model, personID: person.id)
                        } label: {
                            ShannonPersonRow(person: person, palette: palette)
                        }
                        .accessibilityIdentifier("people-person-\(person.id)")
                    }
                } footer: {
                    Text(ShannonPeopleMemoryCopy.rule)
                }
                if !presentation.unnamed.isEmpty {
                    Section {
                        NavigationLink {
                            ShannonPersonDetailPage(model: model, personID: nil)
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ShannonPeopleMemoryCopy.unnamedTitle).foregroundStyle(palette.textPrimary)
                                    Text("覚えていること \(presentation.unnamed.filter { !$0.isForgotten }.count)件")
                                        .font(.caption).foregroundStyle(palette.textSecondary)
                                }
                            } icon: {
                                Image(systemName: "person.crop.circle.badge.questionmark").foregroundStyle(palette.textSecondary)
                            }
                            .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                            .accessibilityElement(children: .combine)
                        }
                        .accessibilityIdentifier("people-unnamed")
                    } footer: {
                        Text(ShannonPeopleMemoryCopy.unnamedFooter)
                    }
                }
            }
        }
        .navigationTitle(ShannonPeopleMemoryCopy.title)
        .task { if model.people == nil { await model.reloadPeople() } }
        .refreshable { await model.reloadPeople() }
    }
}

/// The entry on the Mac overview, where categories are cards rather than list rows.
struct ShannonPeopleEntryLabel: View {
    let people: ShannonPeopleMemoryDTO?
    let palette: ShannonPalette

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: "person.2").foregroundStyle(palette.action)
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text(ShannonPeopleMemoryCopy.title).font(.headline).foregroundStyle(palette.textPrimary)
                Text(ShannonPeopleMemoryPresentation(people: people).summary)
                    .font(.caption).foregroundStyle(palette.textSecondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .accessibilityElement(children: .combine)
    }
}

private struct ShannonPersonRow: View {
    let person: ShannonRememberedPersonDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(person.title)
                .foregroundStyle(person.forgotten ? palette.textSecondary : palette.textPrimary)
            Text(ShannonPeopleMemoryPresentation.subtitle(for: person))
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// One person, or (with `personID == nil`) the calls whose guest never gave a name.
struct ShannonPersonDetailPage: View {
    @Bindable var model: ShannonMemoryModel
    let personID: String?
    @State private var showsRename = false
    @State private var newName = ""
    @State private var mergeTarget: ShannonRememberedPersonDTO?
    @State private var showsForgetPerson = false
    @State private var itemToForget: ShannonPersonMemoryItemDTO?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    private var person: ShannonRememberedPersonDTO? { model.people?.people.first { $0.id == personID } }
    private var items: [ShannonPersonMemoryItemDTO] { personID == nil ? model.people?.unnamed ?? [] : person?.items ?? [] }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if let person { header(person, palette) }
            if let error = model.peopleErrorMessage {
                Section {
                    MemoryErrorCard(message: error, palette: palette) { model.dismissError() }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            ForEach(ShannonPeopleMemoryPresentation.groups(items)) { group in
                Section(group.title) {
                    ForEach(group.items) { item in itemRow(item, palette) }
                }
            }
            if items.isEmpty {
                Section { Text("覚えていることはありません。").foregroundStyle(palette.textSecondary) }
            }
        }
        .navigationTitle(person?.title ?? ShannonPeopleMemoryCopy.unnamedTitle)
        .toolbar { if let person { ToolbarItem(placement: .primaryAction) { personMenu(person) } } }
        .disabled(model.mutatingPeopleID != nil)
        .alert("名前を変更", isPresented: $showsRename) {
            TextField("名前", text: $newName)
            Button("キャンセル", role: .cancel) {}
            Button("保存") {
                guard let personID else { return }
                Task { _ = await model.changePeople(.rename(personID: personID, displayName: newName)) }
            }
            .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("前の名前も、同じ人を見つけるために残します。")
        }
        .confirmationDialog("この人を忘れますか？", isPresented: $showsForgetPerson, titleVisibility: .visible) {
            Button("忘れる", role: .destructive) {
                guard let personID else { return }
                Task { _ = await model.changePeople(.forgetPerson(personID)) }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text(ShannonPeopleMemoryCopy.forgetPerson(person?.title ?? ""))
        }
        .confirmationDialog("この内容を忘れますか？", isPresented: Binding(
            get: { itemToForget != nil }, set: { if !$0 { itemToForget = nil } }), titleVisibility: .visible) {
            Button("忘れる", role: .destructive) {
                guard let item = itemToForget else { return }
                itemToForget = nil
                Task { _ = await model.changePeople(.forgetItem(item.id)) }
            }
            Button("キャンセル", role: .cancel) { itemToForget = nil }
        } message: {
            Text(ShannonPeopleMemoryCopy.forgetItem)
        }
        .confirmationDialog("記録を統合しますか？", isPresented: Binding(
            get: { mergeTarget != nil }, set: { if !$0 { mergeTarget = nil } }), titleVisibility: .visible) {
            Button("統合する", role: .destructive) {
                guard let personID, let target = mergeTarget else { return }
                mergeTarget = nil
                Task { if await model.changePeople(.merge(personID: personID, intoPersonID: target.id)) { dismiss() } }
            }
            Button("キャンセル", role: .cancel) { mergeTarget = nil }
        } message: {
            Text(ShannonPeopleMemoryCopy.merge(person?.title ?? "", into: mergeTarget?.title ?? ""))
        }
    }

    private func header(_ person: ShannonRememberedPersonDTO, _ palette: ShannonPalette) -> some View {
        Section {
            if person.forgotten {
                Label("忘れるよう指定済み", systemImage: "eye.slash.fill").foregroundStyle(palette.danger)
                Button("この人を復元") { Task { _ = await model.changePeople(.restorePerson(person.id)) } }
                    .frame(minHeight: ShannonTouchTarget.minimum)
            }
            LabeledContent("最後に話した日", value: person.lastTalkedAt.map(displayDate) ?? "記録なし")
            if !person.aliases.isEmpty { LabeledContent("ほかの呼び方", value: person.aliases.joined(separator: "、")) }
            if !person.howKnown.isEmpty { LabeledContent("知ったきっかけ", value: person.howKnown) }
        } footer: {
            Text("名前は通話の中の言葉で聞いたものです。声で人を確かめることはしません。")
        }
    }

    private func itemRow(_ item: ShannonPersonMemoryItemDTO, _ palette: ShannonPalette) -> some View {
        Menu {
            if item.isForgotten {
                Button { Task { _ = await model.changePeople(.restoreItem(item.id)) } } label: {
                    Label("復元", systemImage: "arrow.uturn.backward")
                }
            } else {
                let next: ShannonMemorySensitivityDTO = item.sensitivity == .sensitive ? .ordinary : .sensitive
                Button { Task { _ = await model.changePeople(.mark(itemID: item.id, next)) } } label: {
                    Label("\(next.japaneseName)にする", systemImage: next.symbolName)
                }
                Button(role: .destructive) { itemToForget = item } label: { Label("この内容を忘れる", systemImage: "eye.slash") }
            }
        } label: {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text(item.text)
                    .foregroundStyle(item.isForgotten ? palette.textSecondary : palette.textPrimary)
                    .strikethrough(item.isForgotten)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Label(ShannonPeopleMemoryPresentation.caption(for: item), systemImage: item.isForgotten ? "eye.slash" : item.sensitivity.symbolName)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(item.text)。\(ShannonPeopleMemoryPresentation.caption(for: item))")
        .accessibilityHint("扱いの変更、忘れる、復元を選べます")
    }

    private func personMenu(_ person: ShannonRememberedPersonDTO) -> some View {
        Menu {
            Button { newName = person.displayName; showsRename = true } label: { Label("名前を変更", systemImage: "pencil") }
            let others = (model.people?.people ?? []).filter { $0.id != person.id && !$0.forgotten }
            if !others.isEmpty {
                Menu {
                    ForEach(others) { other in Button(other.title) { mergeTarget = other } }
                } label: { Label("ほかの人と統合", systemImage: "arrow.triangle.merge") }
            }
            if !person.forgotten {
                Button(role: .destructive) { showsForgetPerson = true } label: { Label("この人を忘れる", systemImage: "eye.slash") }
            }
        } label: {
            Label("この人の操作", systemImage: "ellipsis.circle")
        }
    }
}
