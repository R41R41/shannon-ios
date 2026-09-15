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
                Text("GitHubリポジトリを追加").font(.title2.weight(.semibold))
                Text("Agent Host専用の作業領域へ取得します。元のリポジトリや既存チェックアウトは変更しません。")
                    .foregroundStyle(.secondary)
            }
            Form {
                TextField("https://github.com/owner/repository", text: $repositoryURL)
                    .onChange(of: repositoryURL) { oldValue, newValue in
                        guard projectKey.isEmpty
                            || projectKey == ShannonDesktopRepositoryInput.suggestedKey(from: oldValue)
                        else { return }
                        projectKey = ShannonDesktopRepositoryInput.suggestedKey(from: newValue)
                    }
                TextField("プロジェクト名", text: $projectKey)
                LabeledContent("追加先", value: hostPreference == .auto ? "このMac＋クラウド" : hostPreference.japaneseName)
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
                Button("キャンセル", action: cancel).disabled(isAdding)
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel(host.map { "実行先、\($0.displayName)、\($0.status.japaneseName)" } ?? "実行先なし")
    }

    private var statusColor: Color {
        switch host?.status {
        case .available: .shannonSuccess
        case .busy: .shannonAttention
        case .offline, nil: .secondary
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
            Button("作業ブランチを用意", action: requestBranch).disabled(!canRequest)
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
            DevelopmentCommandOutput(task: task, title: "ビルド出力")
        }
    }
}

struct DevelopmentPaneHeader: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.headline)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct DevelopmentBuildResultRow: View {
    let test: ShannonAgentTestResult

    var body: some View { Label(test.name, systemImage: symbolName).foregroundStyle(foregroundColor) }

    private var symbolName: String {
        switch test.status {
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .pending: "circle"
        }
    }

    private var foregroundColor: Color { test.status == .failed ? .shannonDanger : .primary }
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
            VStack(alignment: .leading, spacing: 14) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label(title, systemImage: symbol).font(.headline)
        }
    }
}
