import AppKit
import ShannonAppCore
import SwiftUI

/// 作業 can be searched, narrowed, pinned and archived as on the iPhone (roadmap A14). The search and
/// the filter are the same as on the 開発 page: both list the same tasks.
extension ShannonDesktopRootView {
    var workSearchBar: some View {
        HStack(spacing: ShannonDesktopSpacing.medium) {
            TextField("作業を検索", text: $developmentTaskSearchText)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)
            developmentTaskFilterMenu
            Spacer()
        }
    }

    func workTaskSection(_ title: String, subtitle: String, tasks: [ShannonAgentTask]) -> some View {
        DesktopTaskSection(
            title: title,
            subtitle: subtitle,
            tasks: tasks,
            threads: conversation.threads,
            selectedTaskID: selectedTaskID,
            select: selectTask,
            togglePinned: { task in Task { await conversation.toggleAgentTaskPinned(task.id) } },
            setArchived: { task, archived in Task { await conversation.setAgentTaskArchived(task.id, archived: archived) } }
        )
    }
}
