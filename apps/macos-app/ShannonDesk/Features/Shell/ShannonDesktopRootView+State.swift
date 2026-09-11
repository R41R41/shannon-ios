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
            toggleInspector: {
                selectedTaskID = selectedTaskID
                    ?? conversation.latestActiveAgentTask?.id
                    ?? conversation.agentTasks.first?.id
                showsInspector.toggle()
            }
        )
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
