import SwiftUI

public struct ShannonOrganizeSessionCard: View {
    let session: ShannonOrganizeSessionDTO
    let isWorking: Bool
    let error: String?
    let taskCandidatesByItemID: [String: [ShannonVoyagerTaskProjectionDTO]]
    let projects: [ShannonVoyagerProjectProjectionDTO]
    let pendingCatalogItemIDs: Set<String>
    let catalogErrorsByItemID: [String: String]
    let decide: (String, ShannonOrganizeDecisionDTO, String?, String?, ShannonOrganizeOperationDTO?, ShannonVoyagerTaskProjectionDTO?, [String]?) -> Void
    let searchTasks: (String, String) -> Void
    let loadProjects: (String) -> Void
    let apply: () -> Void

    public init(
        session: ShannonOrganizeSessionDTO,
        isWorking: Bool,
        error: String?,
        taskCandidatesByItemID: [String: [ShannonVoyagerTaskProjectionDTO]] = [:],
        projects: [ShannonVoyagerProjectProjectionDTO] = [],
        pendingCatalogItemIDs: Set<String> = [],
        catalogErrorsByItemID: [String: String] = [:],
        decide: @escaping (String, ShannonOrganizeDecisionDTO, String?, String?, ShannonOrganizeOperationDTO?, ShannonVoyagerTaskProjectionDTO?, [String]?) -> Void,
        searchTasks: @escaping (String, String) -> Void = { _, _ in },
        loadProjects: @escaping (String) -> Void = { _ in },
        apply: @escaping () -> Void
    ) {
        self.session = session
        self.isWorking = isWorking
        self.error = error
        self.taskCandidatesByItemID = taskCandidatesByItemID
        self.projects = projects
        self.pendingCatalogItemIDs = pendingCatalogItemIDs
        self.catalogErrorsByItemID = catalogErrorsByItemID
        self.decide = decide
        self.searchTasks = searchTasks
        self.loadProjects = loadProjects
        self.apply = apply
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Label("Voyager Task案", systemImage: "checklist")
                    .font(.shannon(.headline))
                Spacer()
                Text(statusLabel)
                    .font(.shannon(.caption).weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            if session.items.isEmpty {
                Text("この範囲にはTask案がありませんでした。")
                    .font(.shannon(.subheadline))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(session.items) { item in
                    ShannonOrganizeItemRow(
                        item: item,
                        candidates: taskCandidatesByItemID[item.id] ?? [],
                        projects: projects,
                        isLoadingCatalog: pendingCatalogItemIDs.contains(item.id),
                        catalogError: catalogErrorsByItemID[item.id],
                        disabled: isWorking || session.state == .applied,
                        decide: { decision, title, details, operation, target, projectIds in
                            decide(item.id, decision, title, details, operation, target, projectIds)
                        },
                        searchTasks: { searchTasks(item.id, $0) },
                        loadProjects: { loadProjects(item.id) }
                    )
                    if item.id != session.items.last?.id { Divider() }
                }
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.shannon(.caption))
                    .foregroundStyle(Color.shannonAttention)
            }

            if session.state != .applied {
                Button(action: apply) {
                    HStack {
                        if isWorking { ProgressView().controlSize(.small) }
                        Text(applyLabel)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isWorking || !canApply)
            }
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.secondary.opacity(0.18), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private var statusLabel: String {
        switch session.state {
        case .readyForReview: "確認中"
        case .partiallyApplied: "一部未反映"
        case .applied: "反映済み"
        }
    }

    private var canApply: Bool { !session.items.contains(where: { $0.decision == .proposed }) }

    private var applyLabel: String {
        if session.state == .partiallyApplied { return "同じ内容でもう一度反映" }
        return session.items.contains(where: { $0.decision == .accepted }) ? "採用した変更を反映" : "整理を完了"
    }
}

private struct ShannonOrganizeItemRow: View {
    let item: ShannonOrganizeItemDTO
    let candidates: [ShannonVoyagerTaskProjectionDTO]
    let projects: [ShannonVoyagerProjectProjectionDTO]
    let isLoadingCatalog: Bool
    let catalogError: String?
    let disabled: Bool
    let decide: (ShannonOrganizeDecisionDTO, String?, String?, ShannonOrganizeOperationDTO?, ShannonVoyagerTaskProjectionDTO?, [String]?) -> Void
    let searchTasks: (String) -> Void
    let loadProjects: () -> Void

    @State private var isConfiguring = false
    @State private var title: String
    @State private var details: String
    @State private var operation: ShannonOrganizeOperationDTO
    @State private var target: ShannonVoyagerTaskProjectionDTO?
    @State private var selectedProjectIDs: Set<String>
    @State private var taskQuery: String

    init(
        item: ShannonOrganizeItemDTO,
        candidates: [ShannonVoyagerTaskProjectionDTO],
        projects: [ShannonVoyagerProjectProjectionDTO],
        isLoadingCatalog: Bool,
        catalogError: String?,
        disabled: Bool,
        decide: @escaping (ShannonOrganizeDecisionDTO, String?, String?, ShannonOrganizeOperationDTO?, ShannonVoyagerTaskProjectionDTO?, [String]?) -> Void,
        searchTasks: @escaping (String) -> Void,
        loadProjects: @escaping () -> Void
    ) {
        self.item = item
        self.candidates = candidates
        self.projects = projects
        self.isLoadingCatalog = isLoadingCatalog
        self.catalogError = catalogError
        self.disabled = disabled
        self.decide = decide
        self.searchTasks = searchTasks
        self.loadProjects = loadProjects
        let initialOperation = item.operation ?? .create
        _title = State(initialValue: item.title)
        _details = State(initialValue: item.details)
        _operation = State(initialValue: initialOperation)
        _target = State(initialValue: item.target)
        _selectedProjectIDs = State(initialValue: Set(item.projectIds ?? []))
        _taskQuery = State(initialValue: item.targetQuery ?? item.target?.title ?? item.title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: decisionSymbol)
                    .foregroundStyle(decisionColor)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.operation == .update ? "既存Taskを更新" : "新規Task")
                        .font(.shannon(.caption2).weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(item.title).font(.shannon(.subheadline).weight(.semibold))
                    if !item.details.isEmpty { Text(item.details).font(.shannon(.caption)).foregroundStyle(.secondary) }
                    if let target = item.target {
                        Label("変更元：\(target.title) · rev \(target.revision)", systemImage: "arrow.triangle.2.circlepath")
                            .font(.shannon(.caption2))
                            .foregroundStyle(.secondary)
                    }
                    if item.operation == .update {
                        Label("変更項目：\(updateFieldSummary)", systemImage: "slider.horizontal.3")
                            .font(.shannon(.caption2))
                            .foregroundStyle(.secondary)
                    }
                    if let names = selectedProjectNames(for: item.projectIds ?? []) {
                        Label(names, systemImage: "folder")
                            .font(.shannon(.caption2))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if isConfiguring && item.destinationStatus == .pending { configurationEditor }

            if let result = item.result {
                Label("Voyagerに\(item.operation == .update ? "更新" : "作成")：\(result.title)", systemImage: "checkmark.circle.fill")
                    .font(.shannon(.caption).weight(.semibold))
                    .foregroundStyle(Color.shannonSuccess)
                Text("Task Reference: \(result.resourceId)")
                    .font(.shannon(.caption2).monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else if item.destinationStatus == .failed {
                Text(failureMessage).font(.shannon(.caption)).foregroundStyle(Color.shannonAttention)
            }

            if item.destinationStatus == .pending && !isConfiguring {
                HStack(spacing: 8) {
                    Button(item.decision == .accepted ? "採用済み" : "確認して採用") {
                        isConfiguring = true
                        loadProjects()
                    }
                    .buttonStyle(.borderedProminent)
                    Menu {
                        Button("今回は保留") { decide(.deferred, nil, nil, nil, nil, nil) }
                        Button("除外") { decide(.rejected, nil, nil, nil, nil, nil) }
                    } label: { Image(systemName: "ellipsis") }
                }
                .font(.shannon(.caption))
                .disabled(disabled)
            }
        }
        .onChange(of: item.title) { title = item.title }
        .onChange(of: item.details) { details = item.details }
    }

    @ViewBuilder
    private var configurationEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("反映方法", selection: $operation) {
                Text("新規作成").tag(ShannonOrganizeOperationDTO.create)
                Text("既存を更新").tag(ShannonOrganizeOperationDTO.update)
            }
            .pickerStyle(.segmented)

            if operation == .update {
                HStack(spacing: 8) {
                    TextField("Task名で検索", text: $taskQuery).textFieldStyle(.roundedBorder)
                    Button { searchTasks(taskQuery) } label: {
                        if isLoadingCatalog { ProgressView().controlSize(.small) }
                        else { Image(systemName: "magnifyingglass") }
                    }
                    .buttonStyle(.bordered)
                    .disabled(taskQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoadingCatalog)
                }

                if let catalogError { Text(catalogError).font(.shannon(.caption2)).foregroundStyle(Color.shannonAttention) }

                ForEach(candidates) { candidate in
                    Button {
                        target = candidate
                        if !changesTitle { title = candidate.title }
                        if !changesDetails { details = candidate.details }
                        selectedProjectIDs = projectSelectionRequired ? [] : Set(candidate.projectIds)
                    } label: {
                        HStack(alignment: .top) {
                            Image(systemName: target?.id == candidate.id ? "checkmark.circle.fill" : "circle")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.title).font(.shannon(.caption).weight(.semibold))
                                Text("\(candidate.status) · rev \(candidate.revision)")
                                    .font(.shannon(.caption2)).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }

                if let target {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("変更前").font(.shannon(.caption2).weight(.semibold)).foregroundStyle(.secondary)
                        Text(target.title).font(.shannon(.caption))
                        if !target.details.isEmpty { Text(target.details).font(.shannon(.caption2)).foregroundStyle(.secondary) }
                        Text("変更後：\(updateFieldSummary)のみ")
                            .font(.shannon(.caption2).weight(.semibold)).foregroundStyle(.secondary)
                    }
                } else {
                    Text("更新するTaskを1件選んでください。推測では反映しません。")
                        .font(.shannon(.caption2)).foregroundStyle(.secondary)
                }
            }

            if operation == .create || changesTitle {
                TextField("Task名", text: $title).textFieldStyle(.roundedBorder)
            } else if let target {
                Label("タイトルは変更しません：\(target.title)", systemImage: "lock")
                    .font(.shannon(.caption)).foregroundStyle(.secondary)
            }

            if operation == .create || changesDetails {
                TextField("実行内容", text: $details, axis: .vertical)
                    .lineLimit(2...5)
                    .textFieldStyle(.roundedBorder)
            } else if target != nil {
                Label("詳細は変更しません", systemImage: "lock")
                    .font(.shannon(.caption)).foregroundStyle(.secondary)
            }

            if operation == .create || changesProjects {
                Menu {
                    if !projectSelectionRequired {
                        Button { selectedProjectIDs.removeAll() } label: {
                            Label("Projectなし", systemImage: selectedProjectIDs.isEmpty ? "checkmark" : "folder")
                        }
                    }
                    ForEach(projects) { project in
                        Button {
                            if selectedProjectIDs.contains(project.id) { selectedProjectIDs.remove(project.id) }
                            else { selectedProjectIDs.insert(project.id) }
                        } label: {
                            Label(project.title, systemImage: selectedProjectIDs.contains(project.id) ? "checkmark" : "folder")
                        }
                    }
                } label: {
                    Label(selectedProjectSummary, systemImage: "folder")
                        .font(.shannon(.caption))
                }
                if projectSelectionRequired && selectedProjectIDs.isEmpty {
                    Text("この依頼ではProjectを1件以上選んでください。未選択では反映できません。")
                        .font(.shannon(.caption2)).foregroundStyle(Color.shannonAttention)
                }
            } else if let target {
                Label(selectedProjectNames(for: target.projectIds) ?? "Projectなし（変更しません）", systemImage: "lock")
                    .font(.shannon(.caption)).foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                Button("この内容を採用") {
                    decide(.accepted, title, details, operation, operation == .update ? target : nil, Array(selectedProjectIDs).sorted())
                    isConfiguring = false
                }
                .buttonStyle(.borderedProminent)
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || (operation == .update && target == nil)
                    || (projectSelectionRequired && selectedProjectIDs.isEmpty))
                Button("戻る") { resetDraft(); isConfiguring = false }
            }
            .font(.shannon(.caption))
        }
        .padding(10)
        .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .disabled(disabled)
    }

    private var selectedProjectSummary: String { selectedProjectNames(for: Array(selectedProjectIDs)) ?? "Projectなし" }

    private func selectedProjectNames(for ids: [String]) -> String? {
        guard !ids.isEmpty else { return nil }
        return ids.map { id in projects.first(where: { $0.id == id })?.title ?? "Project \(id.prefix(6))" }
            .joined(separator: "、")
    }

    private func resetDraft() {
        title = item.title
        details = item.details
        operation = item.operation ?? .create
        target = item.target
        selectedProjectIDs = Set(item.projectIds ?? [])
        taskQuery = item.targetQuery ?? item.target?.title ?? item.title
    }

    private var failureMessage: String {
        switch item.errorCode {
        case "REVISION_CONFLICT": "Voyager側でTaskが更新されました。新しく「整理して」で候補を作り直してください。"
        case "TASK_NOT_EDITABLE": "完了または取消済みのTaskは更新できません。"
        case "PROJECT_NOT_FOUND": "選択したProjectが見つかりません。新しく「整理して」で選び直してください。"
        case "PROJECT_SELECTION_REQUIRED": "Projectを1件以上選んでから採用してください。"
        default: "未反映：\(item.errorCode ?? "接続エラー")"
        }
    }

    private var effectiveUpdateFields: Set<ShannonOrganizeUpdateFieldDTO> {
        guard operation == .update else { return [] }
        if item.operation == .update, let fields = item.updateFields, !fields.isEmpty { return Set(fields) }
        return [.title, .details, .projectIds]
    }

    private var changesTitle: Bool { effectiveUpdateFields.contains(.title) }
    private var changesDetails: Bool { effectiveUpdateFields.contains(.details) }
    private var changesProjects: Bool { effectiveUpdateFields.contains(.projectIds) }
    private var projectSelectionRequired: Bool {
        operation == .update && changesProjects && item.projectSelectionRequired == true
    }

    private var updateFieldSummary: String {
        let names = [
            ShannonOrganizeUpdateFieldDTO.title,
            .details,
            .projectIds,
        ].filter(effectiveUpdateFields.contains).map { field in
            switch field {
            case .title: "タイトル"
            case .details: "詳細"
            case .projectIds: "Project"
            }
        }
        return names.isEmpty ? "なし" : names.joined(separator: "・")
    }

    private var decisionSymbol: String {
        if item.destinationStatus == .applied { return "checkmark.circle.fill" }
        return switch item.decision {
        case .proposed: "circle"
        case .accepted: "checkmark.circle.fill"
        case .rejected: "xmark.circle"
        case .deferred: "clock"
        }
    }

    private var decisionColor: Color {
        if item.destinationStatus == .applied { return Color.shannonSuccess }
        return switch item.decision {
        case .accepted: Color.shannonActionColor
        case .rejected: Color.secondary
        case .deferred: Color.shannonAttention
        case .proposed: Color.secondary
        }
    }
}
