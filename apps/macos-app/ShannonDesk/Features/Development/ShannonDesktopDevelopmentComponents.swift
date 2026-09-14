import AppKit
import ShannonAppCore
import SwiftUI

struct DevelopmentAddRepositorySheet: View {
    @Binding var repositoryURL: String
    @Binding var projectKey: String
    let hostPreference: ShannonAgentRoutingPreference
    let isAdding: Bool
    let errorMessage: String?
    let cancel: () -> Void
    let add: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text("GitHubリポジトリを追加")
                    .font(.title2.weight(.semibold))
                Text("Agent Host専用の作業領域へ取得します。元のリポジトリや既存チェックアウトは変更しません。")
                    .foregroundStyle(.secondary)
            }

            Form {
                TextField("https://github.com/owner/repository", text: $repositoryURL)
                    .onChange(of: repositoryURL) { oldValue, newValue in
                        guard projectKey.isEmpty || projectKey == ShannonDesktopRepositoryInput.suggestedKey(from: oldValue)
                        else { return }
                        projectKey = ShannonDesktopRepositoryInput.suggestedKey(from: newValue)
                    }
                TextField("プロジェクト名", text: $projectKey)
                LabeledContent(
                    "追加先",
                    value: hostPreference == .auto ? "このMac＋クラウド" : hostPreference.japaneseName
                )
            }
            .formStyle(.grouped)

            Label(
                hostPreference == .auto
                    ? "HTTPSのGitHub URLだけを受け付け、LocalとCloudへ別々に取得します。非公開リポジトリは各HostのGitHub権限を使います。"
                    : "HTTPSのGitHub URLだけを受け付けます。非公開リポジトリは選択したAgent HostのGitHub権限を使います。",
                systemImage: "checkmark.shield"
            )
            .font(.caption)
            .foregroundStyle(.secondary)

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(Color.shannonDanger)
            }

            HStack {
                Spacer()
                Button("キャンセル", action: cancel)
                    .disabled(isAdding)
                Button("追加", action: add)
                    .buttonStyle(.borderedProminent)
                    .disabled(isAdding || !input.isValid)
            }
        }
        .padding(24)
        .frame(width: 520)
        .interactiveDismissDisabled(isAdding)
    }

    private var input: ShannonDesktopRepositoryInput {
        .init(repositoryURL: repositoryURL, projectKey: projectKey)
    }
}

struct DevelopmentRouteBadge: View {
    let host: ShannonAgentHostDTO?

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 7, height: 7)
            Text(host.map { "\($0.displayName) · \($0.status.japaneseName)" } ?? "実行先なし")
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
    }

    private var statusColor: Color {
        switch host?.status {
        case .available: .shannonSuccess
        case .busy: .shannonAttention
        case .offline, nil: .secondary
        }
    }
}

struct DevelopmentFilesPane: View {
    let project: ShannonAgentProjectDTO?
    let task: ShannonAgentTask

    var body: some View {
        DevelopmentPane(title: "ファイルツリー", symbol: "folder") {
            if project?.files.isEmpty != false {
                Text(task.changes.isEmpty
                     ? "Agent Hostへ接続すると、プロジェクトのファイルがここに表示されます。"
                     : "現在の作業で変更したファイルを表示しています。")
                    .foregroundStyle(.secondary)
                ForEach(task.changes) { change in
                    Label(change.displayName, systemImage: "doc")
                }
            } else if let project {
                OutlineGroup(DevelopmentFileNode.roots(paths: project.files), children: \.children) { node in
                    Label(node.name, systemImage: node.children == nil ? "doc" : "folder").help(node.path)
                }
            }
        }
    }
}

struct DevelopmentTerminalPane: View {
    let task: ShannonAgentTask
    @Binding var instruction: String
    let canSend: Bool
    let send: () -> Void

    var body: some View {
        DevelopmentPane(title: "コマンド履歴", symbol: "terminal") {
            HStack {
                TextField("Codexへ実行内容を指示", text: $instruction)
                    .onSubmit(send)
                Button("実行を依頼", action: send)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSend || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Label("コマンドはCodexが内容と権限を確認し、必要な操作だけを実行します。", systemImage: "checkmark.shield")
                .font(.caption)
                .foregroundStyle(.secondary)
            let commands = task.timeline.filter { $0.activity?.kind == .command }
            if commands.isEmpty {
                Text("実行したコマンドの状態は、作業開始後にここへ表示されます。")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(commands) { event in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: event.activity?.status == .failed ? "xmark.circle.fill" : "terminal")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.title)
                            if let detail = event.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Text(event.occurredAt, style: .time).font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }
}

struct DevelopmentChangesPane: View {
    let project: ShannonAgentProjectDTO?
    let task: ShannonAgentTask

    var body: some View {
        DevelopmentPane(title: "差分レビュー", symbol: "doc.text.magnifyingglass") {
            if !task.changes.isEmpty {
                ForEach(task.changes) { change in
                    DevelopmentTaskChangeRow(change: change)
                    Divider()
                }
            } else if project?.changes.isEmpty == false, let project {
                ForEach(project.changes) { change in
                    DevelopmentWorkspaceChangeRow(change: change)
                    Divider()
                }
            } else {
                Text("レビューできる差分はまだありません。").foregroundStyle(.secondary)
            }
        }
    }
}

struct DevelopmentTaskChangeRow: View {
    let change: ShannonAgentChangeSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(change.displayName).fontWeight(.medium)
                    if let path = change.path, path != change.displayName {
                        Text(path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                Spacer()
                Text("+\(change.additions)  −\(change.deletions)")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(change.summary).font(.callout).foregroundStyle(.secondary)
            if let diff = change.diffPreview, !diff.isEmpty {
                DisclosureGroup("行単位の差分") {
                    ScrollView(.horizontal) {
                        Text(diff)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 6)
                    }
                }
            }
        }
    }
}

struct DevelopmentGitPane: View {
    let project: ShannonAgentProjectDTO?
    let task: ShannonAgentTask
    let host: ShannonAgentHostDTO?
    let canRequest: Bool
    let requestBranch: () -> Void

    var body: some View {
        DevelopmentPane(title: "Gitとブランチ", symbol: "arrow.triangle.branch") {
            LabeledContent("プロジェクト", value: project?.key ?? task.projectHint ?? "未選択")
            LabeledContent("現在のブランチ", value: project?.currentBranch ?? "取得待ち")
            LabeledContent("未コミット変更", value: "\(project?.changes.count ?? task.changes.count)件")
            LabeledContent("実行ホスト", value: host?.displayName ?? task.assignedHostID ?? "未割り当て")
            Label("ブランチとworktreeは、選択したAgent Hostの安全境界内で管理します。", systemImage: "checkmark.shield")
                .font(.callout).foregroundStyle(.secondary)
            Button("作業ブランチを用意", action: requestBranch)
                .disabled(!canRequest)
        }
    }
}

struct DevelopmentWorkspaceChangeRow: View {
    let change: ShannonAgentWorkspaceChangeDTO

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(change.path).fontWeight(.medium)
                Spacer()
                Text("+\(change.additions)  −\(change.deletions)")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(change.status).font(.caption.monospaced()).foregroundStyle(.secondary)
        }
    }
}

struct DevelopmentBuildPane: View {
    let task: ShannonAgentTask
    let canRequest: Bool
    let requestBuild: () -> Void

    var body: some View {
        DevelopmentPane(title: "ビルドと検証", symbol: "hammer") {
            Button("標準ビルドとテストを依頼", action: requestBuild)
                .buttonStyle(.borderedProminent)
                .disabled(!canRequest)
            if task.tests.isEmpty {
                Text("ビルドやテストの結果はまだありません。").foregroundStyle(.secondary)
            } else {
                ForEach(task.tests) { DevelopmentBuildResultRow(test: $0) }
            }
        }
    }
}

struct DevelopmentBuildResultRow: View {
    let test: ShannonAgentTestResult

    var body: some View {
        Label(test.name, systemImage: symbolName).foregroundStyle(foregroundColor)
    }

    private var symbolName: String {
        switch test.status {
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .pending: "circle"
        }
    }

    private var foregroundColor: Color {
        test.status == .failed ? .shannonDanger : .primary
    }
}

struct DevelopmentPane<Content: View>: View {
    let title: String
    let symbol: String
    let content: Content

    init(title: String, symbol: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.content = content()
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label(title, systemImage: symbol)
                .font(.headline)
        }
    }
}
