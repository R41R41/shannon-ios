import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

extension ShannonDesktopRootView {
    var workOverview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("作業全体")
                        .font(.largeTitle.weight(.semibold))
                    Text("何を目指し、いまどこにいて、次に何をするかを一つの面で見渡します。")
                        .foregroundStyle(.secondary)
                }

                if conversation.agentTasks.isEmpty {
                    ContentUnavailableView(
                        "進行中の作業はありません",
                        systemImage: "checkmark.circle",
                        description: Text("会話の中でシャノンに作業を依頼すると、ここに計画と現在地が表示されます。")
                    )
                    .frame(maxWidth: .infinity, minHeight: 320)
                } else {
                    DesktopTaskSection(
                        title: "いま",
                        subtitle: "進行・確認待ち・一時停止",
                        tasks: workProjection.active,
                        threads: conversation.threads,
                        selectedTaskID: selectedTaskID,
                        select: selectTask
                    )
                    DesktopTaskSection(
                        title: "これから",
                        subtitle: "シャノンからの提案。開始はあなたが決めます",
                        tasks: workProjection.proposed,
                        threads: conversation.threads,
                        selectedTaskID: selectedTaskID,
                        select: selectTask
                    )
                    DesktopTaskSection(
                        title: "完了",
                        subtitle: "検証結果と変更内容を残します",
                        tasks: workProjection.finished,
                        threads: conversation.threads,
                        selectedTaskID: selectedTaskID,
                        select: selectTask
                    )
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .toolbar {
            Button {
                Task { await conversation.synchronizeAgentTasks() }
            } label: {
                Label("更新", systemImage: "arrow.clockwise")
            }
            Button {
                prepareTaskInspectorSelection()
                toggleAuxiliaryPanel(.task)
            } label: {
                Label("現在地", systemImage: "sidebar.trailing")
            }
        }
    }

    var taskInspector: some View {
        Group {
            if let task = selectedTask {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack(spacing: 10) {
                            ShannonAvatarView(expression: task.expression, size: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("現在地")
                                    .font(.headline)
                                Text(task.status.japaneseName)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button {
                                showsInspector = false
                            } label: {
                                Image(systemName: "xmark")
                            }
                            .buttonStyle(.borderless)
                            .help("補助パネルを閉じる")
                        }

                        DesktopTaskStageRail(progress: task.stageProgress)

                        if let project = task.projectHint, !project.isEmpty {
                            Label(project, systemImage: "folder")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .help(project)
                        }

                        DesktopInspectorSection(title: "目的") {
                            DesktopExpandableText(task.goal, collapsedLineLimit: 6)
                        }
                        DesktopInspectorSection(title: "いま") {
                            DesktopExpandableText(task.currentAction ?? task.summary, collapsedLineLimit: 5)
                            if let progress = task.progressFraction {
                                ProgressView(value: progress)
                                Text("全\(task.plan.count)工程中 \(task.completedPlanCount)工程完了")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        DesktopInspectorSection(title: "次") {
                            DesktopExpandableText(
                                ShannonDesktopWorkProjection.nextAction(for: task),
                                collapsedLineLimit: 4
                            )
                        }
                        DesktopInspectorSection(title: "シャノンの様子") {
                            Label(
                                DesktopExpressionLabel.stateDescription(for: task.expression),
                                systemImage: "sparkles"
                            )
                            .foregroundStyle(.secondary)
                        }
                        DesktopInspectorSection(title: "会話") {
                            let context = ShannonDesktopConversationContext(task: task)
                            Label(context.title(in: conversation.threads), systemImage: "bubble.left.and.text.bubble.right")
                                .foregroundStyle(.secondary)
                            Button(context.sourceMessageID == nil ? "元のトークを開く" : "依頼したメッセージへ移動") {
                                openTaskConversation(task)
                            }
                        }

                        if let error = conversation.agentTaskActionError(task.id) {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(Color.shannonAttention)
                                Text(error)
                                    .font(.callout)
                                Spacer(minLength: 8)
                                Button("閉じる") { conversation.dismissAgentTaskActionError(task.id) }
                                    .buttonStyle(.borderless)
                            }
                            .padding(12)
                            .background(Color.shannonAttention.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                        }

                        let policy = ShannonDesktopTaskActionPolicy(status: task.status)
                        if policy.canStart {
                            Button("この作業を始める") {
                                Task { await conversation.startAgentTask(task.id) }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(conversation.isAgentTaskActionInFlight(task.id))
                        }

                        if let approval = task.pendingApproval {
                            VStack(alignment: .leading, spacing: 10) {
                                Label("あなたの確認が必要です", systemImage: "hand.raised.fill")
                                    .font(.headline)
                                Text(approval.title)
                                Text(approval.reason)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Button("許可") {
                                        Task { await conversation.resolveAgentApproval(task.id, accepted: true) }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    Button("許可しない") {
                                        Task { await conversation.resolveAgentApproval(task.id, accepted: false) }
                                    }
                                }
                            }
                            .padding(14)
                            .background(Color.shannonAttention.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                        }

                        if !task.plan.isEmpty {
                            DesktopInspectorSection(title: "計画") {
                                ForEach(task.plan) { item in
                                    Label(item.title, systemImage: item.status.symbolName)
                                        .foregroundStyle(item.status == .pending ? .secondary : .primary)
                                }
                            }
                        }

                        if !task.timeline.isEmpty {
                            DesktopInspectorSection(title: "最近の進捗") {
                                ForEach(Array(task.timeline.suffix(6))) { event in
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(alignment: .firstTextBaseline) {
                                            Image(systemName: event.tone.desktopSymbolName)
                                                .foregroundStyle(event.tone.desktopColor)
                                            Text(event.title)
                                            Spacer(minLength: 8)
                                            Text(event.occurredAt, style: .time)
                                                .font(.caption)
                                                .foregroundStyle(.tertiary)
                                        }
                                        if let detail = event.detail, !detail.isEmpty {
                                            Text(detail)
                                                .font(.callout)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(4)
                                                .help(detail)
                                                .padding(.leading, 22)
                                        }
                                    }
                                }
                            }
                        }

                        if !task.changes.isEmpty {
                            DesktopInspectorSection(title: "変更") {
                                ForEach(task.changes) { change in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(change.displayName)
                                        Text(change.summary)
                                            .font(.callout)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(3)
                                            .help(change.summary)
                                        if change.additions > 0 || change.deletions > 0 {
                                            Text("+\(change.additions)  −\(change.deletions)")
                                                .font(.caption.monospacedDigit())
                                                .foregroundStyle(.tertiary)
                                        }
                                    }
                                }
                            }
                        }

                        if !task.tests.isEmpty {
                            DesktopInspectorSection(title: "検証") {
                                ForEach(task.tests) { test in
                                    Label {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(test.name)
                                            if let detail = test.detail, !detail.isEmpty {
                                                Text(detail)
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                    } icon: {
                                        Image(systemName: test.status.desktopSymbolName)
                                            .foregroundStyle(test.status.desktopColor)
                                    }
                                }
                            }
                        }

                        if policy.canSteer {
                            DesktopInspectorSection(title: "追加の指示") {
                                TextField("この作業へ伝えること", text: $steeringText, axis: .vertical)
                                    .lineLimit(2...5)
                                Button("指示を送る") {
                                    let instruction = steeringText
                                    steeringText = ""
                                    Task { await conversation.steerAgentTask(task.id, instruction: instruction) }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(
                                    steeringText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        || conversation.isAgentTaskActionInFlight(task.id)
                                )
                            }
                        }

                        if policy.canPause || policy.canResume || policy.canCancel {
                            Divider()
                            HStack {
                                if policy.canPause || policy.canResume {
                                    Button(policy.canResume ? "作業を再開" : "一時停止") {
                                        Task { await conversation.toggleAgentTaskPause(task.id) }
                                    }
                                }
                                Spacer()
                                if policy.canCancel {
                                    Button(policy.canStart ? "今回は始めない" : "作業を中止", role: .destructive) {
                                        Task { await conversation.cancelAgentTask(task.id) }
                                    }
                                }
                            }
                            .disabled(conversation.isAgentTaskActionInFlight(task.id))
                        }
                    }
                    .padding(18)
                }
            } else {
                ContentUnavailableView(
                    "作業はありません",
                    systemImage: "sidebar.trailing",
                    description: Text("会話から作業を始めると、ここに現在地が表示されます。")
                )
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
