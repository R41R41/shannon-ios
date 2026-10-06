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
        Group {
            if paths.isEmpty {
                ContentUnavailableView(
                    "ファイルを取得できません",
                    systemImage: "folder.badge.questionmark",
                    description: Text("Agent Hostへ接続すると、プロジェクトのファイルが表示されます。")
                )
            } else {
                DesktopWidthAdaptive(threshold: ShannonDesktopDevelopmentLayout.changeNavigatorThreshold) {
                    HStack(spacing: 0) {
                        fileNavigator.frame(width: 270)
                        Divider()
                        resourceDetail.frame(minWidth: 360)
                    }
                } compact: {
                    VStack(spacing: 0) {
                        compactPicker
                        Divider()
                        resourceDetail
                    }
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
        .padding(ShannonDesktopSpacing.medium)
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
        Group {
            if changes.isEmpty {
                ContentUnavailableView(
                    "レビューできる差分はありません",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("コードが変更されると、ファイルごとの内容がここに表示されます。")
                )
            } else {
                DesktopWidthAdaptive(threshold: ShannonDesktopDevelopmentLayout.changeNavigatorThreshold) {
                    HStack(spacing: 0) {
                        changeList.frame(width: 240)
                        Divider()
                        changeDetail.frame(minWidth: 360)
                    }
                } compact: {
                    VStack(spacing: 0) {
                        compactPicker
                        Divider()
                        changeDetail
                    }
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
        .padding(ShannonDesktopSpacing.medium)
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
    @State private var viewport = CGSize.zero

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
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
                    .padding(ShannonDesktopSpacing.small)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ScrollView([.horizontal, .vertical]) {
                Group {
                    if content.isEmpty {
                        Text(kind == .diff ? "このファイルには行単位の差分がありません。" : "空のファイルです。")
                            .foregroundStyle(.secondary)
                            .padding(ShannonDesktopSpacing.large)
                    } else if kind == .diff {
                        DevelopmentDiffText(diff: content)
                            .padding(.vertical, ShannonDesktopSpacing.small)
                    } else {
                        Text(content)
                            .font(.shannonDesktop(.caption).monospaced())
                            .textSelection(.enabled)
                            .padding(ShannonDesktopSpacing.medium)
                    }
                }
                .frame(minWidth: viewport.width, minHeight: viewport.height, alignment: .topLeading)
            }
            // The visible size is read beside the scroll view, not by a reader around it (see DesktopWidthAdaptive).
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                if size != viewport { viewport = size }
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
            VStack(alignment: .leading, spacing: ShannonDesktopSpacing.extraSmall) {
                Text(change.displayName).font(.shannonDesktop(.headline))
                Text(change.path)
                    .font(.shannonDesktop(.caption).monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            DevelopmentChangeCount(change: change)
        }
        .padding(ShannonDesktopSpacing.medium)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct DevelopmentReviewChangeRow: View {
    let change: ShannonDesktopReviewChange

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonDesktopSpacing.extraSmall) {
            Text(change.displayName).fontWeight(.medium).lineLimit(1)
            HStack(spacing: 6) {
                if let status = change.status { Text(status).font(.shannonDesktop(.caption).monospaced()) }
                DevelopmentChangeCount(change: change)
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, ShannonDesktopSpacing.extraSmall)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(change.displayName)、追加\(change.additions)行、削除\(change.deletions)行")
    }
}

private struct DevelopmentChangeCount: View {
    let change: ShannonDesktopReviewChange
    var body: some View {
        Text("+\(change.additions)  −\(change.deletions)")
            .font(.shannonDesktop(.caption).monospacedDigit())
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
                    .font(.shannonDesktop(.caption).monospaced())
                    .foregroundStyle(foreground(for: line.text))
                    .textSelection(.enabled)
                    .padding(.horizontal, ShannonDesktopSpacing.medium)
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

/// Shows `wide` from `threshold` points of width and `compact` below it.
///
/// On macOS 26 the sidebar and the inspector float over the detail column and give it safe-area insets
/// (252 and 286 points by default). 開発 pinned its panes to the visible width with a `GeometryReader`, and
/// its `HSplitView` extends under both overlays and pads its panes by those insets through AppKit
/// constraints. With the inspector restored at launch the pinned width and those constraints disagreed on
/// every pass, and AppKit asked for another Update Constraints pass until the window threw (TestFlight
/// build 145); either pinning was enough. So the panes are a SwiftUI `HStack` that takes its natural size,
/// and the width is read with `onGeometryChange` on the container. `scripts/check-architecture.mjs` and
/// `scripts/smoke-macos-inspector-launch.sh` keep it so.
struct DesktopWidthAdaptive<Wide: View, Compact: View>: View {
    let threshold: CGFloat
    @ViewBuilder let wide: () -> Wide
    @ViewBuilder let compact: () -> Compact
    @State private var showsWide: Bool?

    var body: some View {
        Group {
            if showsWide == true { wide() } else { compact() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            let next = ShannonDesktopDevelopmentLayout.showsWide(width: width, threshold: threshold, showingWide: showsWide)
            if next != showsWide { showsWide = next }
        }
    }
}
