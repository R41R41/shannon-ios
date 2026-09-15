import ShannonAppCore
import SwiftUI

struct DevelopmentTerminalPane: View {
    let task: ShannonAgentTask
    @Binding var instruction: String
    let canSend: Bool
    let send: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        DevelopmentPane(title: "コマンドと出力", symbol: "terminal") {
            HStack {
                TextField("Codexへ実行内容を指示", text: $instruction).onSubmit(send)
                Button("実行を依頼", action: send)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSend || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Label("コマンドはCodexが内容と権限を確認し、必要な操作だけを実行します。", systemImage: "checkmark.shield")
                .font(.caption)
                .foregroundStyle(.secondary)
            commandHistory
            DevelopmentCommandOutput(task: task, title: "実行出力")
        }
    }

    @ViewBuilder private var commandHistory: some View {
        let commands = task.timeline.filter { $0.activity?.kind == .command && $0.title != "実行出力" }
        if commands.isEmpty {
            Text("実行したコマンドの状態は、作業開始後にここへ表示されます。")
                .foregroundStyle(.secondary)
        } else {
            ForEach(commands.suffix(20)) { event in
                HStack(alignment: .firstTextBaseline) {
                    Image(systemName: symbol(for: event.activity?.status))
                        .foregroundStyle(color(for: event.activity?.status))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.title)
                        if let detail = event.detail {
                            Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                    Spacer()
                    Text(event.occurredAt, style: .time).font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func symbol(for status: ShannonAgentTimelineActivityStatus?) -> String {
        switch status {
        case .running: "hourglass"
        case .failed: "xmark.circle.fill"
        case .completed: "checkmark.circle.fill"
        case nil: "terminal"
        }
    }

    private func color(for status: ShannonAgentTimelineActivityStatus?) -> Color {
        switch status {
        case .failed: .shannonDanger
        case .completed: .shannonSuccess
        case .running: .shannonAction(for: colorScheme)
        case nil: .secondary
        }
    }
}

struct DevelopmentCommandOutput: View {
    let task: ShannonAgentTask
    let title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(title, systemImage: "text.alignleft")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let status = latestStatus {
                    Label(statusTitle(status), systemImage: statusSymbol(status))
                        .font(.caption)
                        .foregroundStyle(status == .failed ? Color.shannonDanger : .secondary)
                }
            }
            if output.isEmpty {
                Text("出力は実行中にここへ表示されます。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 90, alignment: .center)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            } else {
                ScrollView([.horizontal, .vertical]) {
                    Text(output)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .frame(minHeight: 140, maxHeight: 360)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel(title)
                .accessibilityValue(output)
            }
        }
    }

    private var outputEvents: [ShannonAgentTimelineEvent] {
        task.timeline.filter { $0.title == "実行出力" && $0.detail?.isEmpty == false }
    }

    private var output: String {
        outputEvents.suffix(120).compactMap(\.detail).joined()
    }

    private var latestStatus: ShannonAgentTimelineActivityStatus? {
        task.timeline.last(where: { $0.activity?.kind == .command })?.activity?.status
    }

    private func statusTitle(_ status: ShannonAgentTimelineActivityStatus) -> String {
        switch status {
        case .running: "実行中"
        case .completed: "完了"
        case .failed: "失敗"
        }
    }

    private func statusSymbol(_ status: ShannonAgentTimelineActivityStatus) -> String {
        switch status {
        case .running: "circle.dotted"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }
}
