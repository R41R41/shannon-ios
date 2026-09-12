import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

extension ShannonDesktopRootView {
    var shannonActionColor: Color {
        .shannonAction(for: colorScheme)
    }

    var threadProjection: ShannonDesktopThreadProjection {
        ShannonDesktopThreadProjection(
            threads: conversation.threads,
            initiativeThreadIDs: conversation.initiativeThreadIDs,
            query: searchText
        )
    }

    var destination: DesktopDestination {
        ShannonDesktopWindowRestoration.destination(
            sceneRawValue: restoredDestinationRawValue,
            lastRawValue: lastDestinationRawValue
        )
    }

    var desktopCommandActions: ShannonDesktopCommandActions {
        ShannonDesktopCommandActions(
            focusThreadSearch: focusThreadSearch,
            showTalk: { selectDestination(.talk) },
            showWork: { selectDestination(.work) },
            showMemory: { selectDestination(.memory) },
            showSettings: { selectDestination(.settings) },
            toggleOutline: { toggleAuxiliaryPanel(.outline) },
            toggleTaskInspector: {
                prepareTaskInspectorSelection()
                toggleAuxiliaryPanel(.task)
            }
        )
    }

    var auxiliaryInspector: some View {
        VStack(spacing: 0) {
            Picker("補助パネル", selection: $auxiliaryPanel) {
                ForEach(DesktopAuxiliaryPanel.allCases, id: \.self) { panel in
                    Label(panel.title, systemImage: panel.symbolName)
                        .tag(panel)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(10)

            Divider()

            switch auxiliaryPanel {
            case .outline:
                DesktopConversationOutlineView(
                    summary: conversation.selectedThread?.summary,
                    entries: conversationOutline,
                    activeEntryID: activeConversationOutlineEntryID,
                    close: { showsInspector = false },
                    select: requestConversationOutlineJump
                )
            case .task:
                taskInspector
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    var selectedTask: ShannonAgentTask? {
        if let selectedTaskID,
           let task = conversation.agentTasks.first(where: { $0.id == selectedTaskID }) {
            return task
        }
        return conversation.latestActiveAgentTask ?? conversation.agentTasks.first
    }

    var workProjection: ShannonDesktopWorkProjection {
        ShannonDesktopWorkProjection(tasks: conversation.agentTasks)
    }

    var conversationOutline: [ShannonDesktopConversationOutlineEntry] {
        ShannonDesktopConversationOutline.entries(from: conversation.messages)
    }

    var renameAlertBinding: Binding<Bool> {
        Binding(
            get: { renameThread != nil },
            set: { if !$0 { renameThread = nil } }
        )
    }
}
