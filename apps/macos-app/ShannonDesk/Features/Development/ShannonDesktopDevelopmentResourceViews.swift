import AppKit
import ShannonAppCore
import SwiftUI

struct DevelopmentFilesPane: View {
    let project: ShannonAgentProjectDTO?
    let task: ShannonAgentTask
    @Binding var selectedPath: String?
    let resource: ShannonDesktopWorkspaceResourceState
    let load: (String, ShannonAgentWorkspaceResourceKind) -> Void

    var body: some View {
        GeometryReader { proxy in
            if paths.isEmpty {
                ContentUnavailableView(
                    "ファイルを取得できません",
                    systemImage: "folder.badge.questionmark",
                    description: Text("Agent Hostへ接続すると、プロジェクトのファイルが表示されます。")
                )
            } else if ShannonDesktopDevelopmentLayout.showsChangeNavigator(availableWidth: proxy.size.width) {
                HSplitView {
                    fileNavigator.frame(minWidth: 210, idealWidth: 270, maxWidth: 360)
                    resourceDetail.frame(minWidth: 360)
                }
            } else {
                VStack(spacing: 0) {
                    compactPicker
                    Divider()
                    resourceDetail
                }
            }
        }
        .onAppear(perform: loadSelection)
        .onChange(of: selectedPath) { loadSelection() }
    }

    private var paths: [String] {
        if let files = project?.files, !files.isEmpty { return files }
        return task.changes.compactMap { $0.path }
    }

    private var fileNavigator: some View {
        VStack(spacing: 0) {
            DevelopmentPaneHeader(title: "ファイル", symbol: "folder")
            Divider()
            List(selection: $selectedPath) {
                OutlineGroup(DevelopmentFileNode.roots(paths: paths), children: \.children) { node in
                    Label(node.name, systemImage: node.children == nil ? "doc.text" : "folder")
                        .tag(node.children == nil ? Optional(node.path) : nil)
                        .help(node.path)
                }
            }
            .listStyle(.sidebar)
        }
    }

    private var compactPicker: some View {
        Picker("ファイル", selection: $selectedPath) {
            Text("ファイルを選択").tag(String?.none)
            ForEach(paths, id: \.self) { Text($0).tag(Optional($0)) }
        }
        .labelsHidden()
        .padding(10)
        .frame(maxWidth: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var resourceDetail: some View {
        DevelopmentWorkspaceResourceDetail(path: selectedPath, kind: .file, state: resource, retry: loadSelection)
    }

    private func loadSelection() {
        if selectedPath == nil { selectedPath = paths.first }
        guard let selectedPath, !resource.matches(path: selectedPath, kind: .file) else { return }
        load(selectedPath, .file)
    }
}

struct DevelopmentChangesPane: View {
    let project: ShannonAgentProjectDTO?
    let task: ShannonAgentTask
    @Binding var selectedPath: String?
    let resource: ShannonDesktopWorkspaceResourceState
    let load: (String, ShannonAgentWorkspaceResourceKind) -> Void

    var body: some View {
        GeometryReader { proxy in
            if changes.isEmpty {
                ContentUnavailableView(
                    "レビューできる差分はありません",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("コードが変更されると、ファイルごとの内容がここに表示されます。")
                )
            } else if ShannonDesktopDevelopmentLayout.showsChangeNavigator(availableWidth: proxy.size.width) {
                HSplitView {
                    changeList.frame(minWidth: 190, idealWidth: 240, maxWidth: 320)
                    changeDetail.frame(minWidth: 360)
                }
            } else {
                VStack(spacing: 0) {
                    compactPicker
                    Divider()
                    changeDetail
                }
            }
        }
        .onAppear(perform: loadSelection)
        .onChange(of: selectedPath) { loadSelection() }
    }

    private var changes: [ShannonDesktopReviewChange] {
        ShannonDesktopReviewChange.items(project: project, task: task)
    }

    private var selectedChange: ShannonDesktopReviewChange? {
        changes.first { $0.path == selectedPath } ?? changes.first
    }

    private var changeList: some View {
        VStack(spacing: 0) {
            DevelopmentPaneHeader(title: "変更ファイル", symbol: "doc.on.doc")
            Divider()
            List(changes, selection: $selectedPath) { change in
                DevelopmentReviewChangeRow(change: change).tag(Optional(change.path))
            }
            .listStyle(.inset)
        }
    }

    private var compactPicker: some View {
        HStack {
            Picker("変更ファイル", selection: $selectedPath) {
                ForEach(changes) { Text($0.displayName).tag(Optional($0.path)) }
            }
            .labelsHidden()
            Spacer()
            if let selectedChange { DevelopmentChangeCount(change: selectedChange) }
        }
        .padding(10)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder private var changeDetail: some View {
        if let change = selectedChange {
            VStack(spacing: 0) {
                DevelopmentReviewHeader(change: change)
                Divider()
                DevelopmentWorkspaceResourceDetail(
                    path: change.path,
                    kind: .diff,
                    state: resource,
                    fallback: change.diffPreview,
                    retry: loadSelection
                )
            }
        } else {
            ContentUnavailableView("変更ファイルを選択", systemImage: "doc.text.magnifyingglass")
        }
    }

    private func loadSelection() {
        if !changes.contains(where: { $0.path == selectedPath }) { selectedPath = changes.first?.path }
        guard let path = selectedChange?.path, !resource.matches(path: path, kind: .diff) else { return }
        load(path, .diff)
    }
}

private struct DevelopmentWorkspaceResourceDetail: View {
    let path: String?
    let kind: ShannonAgentWorkspaceResourceKind
    let state: ShannonDesktopWorkspaceResourceState
    var fallback: String?
    let retry: () -> Void

    init(
        path: String?,
        kind: ShannonAgentWorkspaceResourceKind,
        state: ShannonDesktopWorkspaceResourceState,
        fallback: String? = nil,
        retry: @escaping () -> Void
    ) {
        self.path = path
        self.kind = kind
        self.state = state
        self.fallback = fallback
        self.retry = retry
    }

    var body: some View {
        Group {
            if let path, case let .loaded(resource) = state,
               resource.path == path, resource.kind == kind {
                if resource.status == .failed {
                    failure(resource.errorMessage ?? "内容を取得できませんでした。")
                } else {
                    text(resource.content ?? "", truncated: resource.truncated)
                }
            } else if let path, case let .failed(resourcePath, resourceKind, message) = state,
                      resourcePath == path, resourceKind == kind {
                failure(message)
            } else if let path, case let .loading(resourcePath, resourceKind) = state,
                      resourcePath == path, resourceKind == kind {
                ProgressView(kind == .diff ? "詳細な差分を取得中" : "ファイルを読み込み中")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let fallback, !fallback.isEmpty {
                text(fallback, truncated: true)
            } else {
                ContentUnavailableView("内容を選択", systemImage: kind == .diff ? "doc.text.magnifyingglass" : "doc.text")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private func text(_ content: String, truncated: Bool) -> some View {
        VStack(spacing: 0) {
            if truncated {
                Label("安全な表示上限まで表示しています", systemImage: "scissors")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            GeometryReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    Group {
                        if content.isEmpty {
                            Text(kind == .diff ? "このファイルには行単位の差分がありません。" : "空のファイルです。")
                                .foregroundStyle(.secondary)
                                .padding(16)
                        } else if kind == .diff {
                            DevelopmentDiffText(diff: content)
                                .padding(.vertical, 8)
                        } else {
                            Text(content)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(12)
                        }
                    }
                    .frame(
                        minWidth: proxy.size.width,
                        minHeight: proxy.size.height,
                        alignment: .topLeading
                    )
                }
            }
        }
    }

    private func failure(_ message: String) -> some View {
        ContentUnavailableView {
            Label("表示できません", systemImage: "lock.doc")
        } description: {
            Text(message)
        } actions: {
            Button("再試行", action: retry)
        }
    }
}

private struct DevelopmentReviewHeader: View {
    let change: ShannonDesktopReviewChange

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(change.displayName).font(.headline)
                Text(change.path)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            DevelopmentChangeCount(change: change)
        }
        .padding(12)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct DevelopmentReviewChangeRow: View {
    let change: ShannonDesktopReviewChange

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(change.displayName).fontWeight(.medium).lineLimit(1)
            HStack(spacing: 6) {
                if let status = change.status { Text(status).font(.caption.monospaced()) }
                DevelopmentChangeCount(change: change)
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(change.displayName)、追加\(change.additions)行、削除\(change.deletions)行")
    }
}

private struct DevelopmentChangeCount: View {
    let change: ShannonDesktopReviewChange
    var body: some View {
        Text("+\(change.additions)  −\(change.deletions)")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
    }
}

private struct DevelopmentDiffText: View {
    let lines: [ShannonDesktopDiffLine]
    @Environment(\.colorScheme) private var colorScheme

    init(diff: String) {
        lines = ShannonDesktopDiffProjection.lines(in: diff)
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(lines) { line in
                Text(line.text.isEmpty ? " " : line.text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(foreground(for: line.text))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(background(for: line.text))
            }
        }
    }

    private func foreground(for line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .shannonSuccess }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .shannonDanger }
        if line.hasPrefix("@@") { return .shannonAction(for: colorScheme) }
        return .primary
    }

    private func background(for line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .shannonSuccess.opacity(0.10) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .shannonDanger.opacity(0.10) }
        return .clear
    }
}
