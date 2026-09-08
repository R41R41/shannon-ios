import SwiftUI

public struct ShannonOrganizeSessionCard: View {
    let session: ShannonOrganizeSessionDTO
    let isWorking: Bool
    let error: String?
    let decide: (String, ShannonOrganizeDecisionDTO, String?, String?) -> Void
    let apply: () -> Void

    public init(
        session: ShannonOrganizeSessionDTO,
        isWorking: Bool,
        error: String?,
        decide: @escaping (String, ShannonOrganizeDecisionDTO, String?, String?) -> Void,
        apply: @escaping () -> Void
    ) {
        self.session = session
        self.isWorking = isWorking
        self.error = error
        self.decide = decide
        self.apply = apply
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Label("Voyager Task案", systemImage: "checklist")
                    .font(.headline)
                Spacer()
                Text(statusLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            if session.items.isEmpty {
                Text("この範囲にはTask案がありませんでした。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(session.items) { item in
                    ShannonOrganizeItemRow(
                        item: item,
                        disabled: isWorking || session.state == .applied,
                        decide: { decision, title, details in decide(item.id, decision, title, details) }
                    )
                    if item.id != session.items.last?.id { Divider() }
                }
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
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

    private var canApply: Bool {
        !session.items.contains(where: { $0.decision == .proposed })
    }

    private var applyLabel: String {
        if session.state == .partiallyApplied { return "同じ内容でもう一度反映" }
        return session.items.contains(where: { $0.decision == .accepted }) ? "採用したTaskを反映" : "整理を完了"
    }
}

private struct ShannonOrganizeItemRow: View {
    let item: ShannonOrganizeItemDTO
    let disabled: Bool
    let decide: (ShannonOrganizeDecisionDTO, String?, String?) -> Void
    @State private var isEditing = false
    @State private var title: String
    @State private var details: String

    init(
        item: ShannonOrganizeItemDTO,
        disabled: Bool,
        decide: @escaping (ShannonOrganizeDecisionDTO, String?, String?) -> Void
    ) {
        self.item = item
        self.disabled = disabled
        self.decide = decide
        _title = State(initialValue: item.title)
        _details = State(initialValue: item.details)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: decisionSymbol)
                    .foregroundStyle(decisionColor)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 5) {
                    if isEditing {
                        TextField("Task名", text: $title)
                            .textFieldStyle(.roundedBorder)
                        TextField("実行内容", text: $details, axis: .vertical)
                            .lineLimit(2...5)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        Text(item.title).font(.subheadline.weight(.semibold))
                        if !item.details.isEmpty {
                            Text(item.details).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if let result = item.result {
                Label("Voyagerに作成：\(result.title)", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
                Text("Task Reference: \(result.resourceId)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else if item.destinationStatus == .failed {
                Text("未反映：\(item.errorCode ?? "接続エラー")")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if item.destinationStatus == .pending {
                HStack(spacing: 8) {
                    if isEditing {
                        Button("編集して採用") {
                            decide(.accepted, title, details)
                            isEditing = false
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("戻る") {
                            title = item.title
                            details = item.details
                            isEditing = false
                        }
                    } else {
                        Button(item.decision == .accepted ? "採用済み" : "採用") { decide(.accepted, nil, nil) }
                            .buttonStyle(.borderedProminent)
                        Button("編集") { isEditing = true }
                        Menu {
                            Button("今回は保留") { decide(.deferred, nil, nil) }
                            Button("除外") { decide(.rejected, nil, nil) }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                    }
                }
                .font(.caption)
                .disabled(disabled)
            }
        }
        .onChange(of: item.title) { title = item.title }
        .onChange(of: item.details) { details = item.details }
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
        if item.destinationStatus == .applied { return .green }
        return switch item.decision {
        case .accepted: Color.accentColor
        case .rejected: Color.secondary
        case .deferred: Color.orange
        case .proposed: Color.secondary
        }
    }
}
