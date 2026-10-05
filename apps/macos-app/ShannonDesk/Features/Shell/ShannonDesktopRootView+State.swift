import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

enum DesktopSidebarSelection: Hashable {
    case destination(DesktopDestination)
    case thread(String)
}

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

    var sidebarSelection: Binding<DesktopSidebarSelection?> {
        Binding(
            get: {
                if destination == .talk, let threadID = conversation.selectedThreadId {
                    return .thread(threadID)
                }
                return .destination(destination)
            },
            set: { selection in
                guard let selection else { return }
                switch selection {
                case let .destination(destination):
                    selectDestination(destination)
                case let .thread(threadID):
                    Task {
                        if let thread = conversation.threads.first(where: { $0.threadId == threadID }) {
                            await openSidebarThread(thread)
                        }
                    }
                }
            }
        )
    }

    var desktopCommandActions: ShannonDesktopCommandActions {
        ShannonDesktopCommandActions(
            focusThreadSearch: focusThreadSearch,
            showTalk: { selectDestination(.talk) },
            showWork: { selectDestination(.work) },
            showMemory: { selectDestination(.memory) },
            showDevelopment: { selectDestination(.development) },
            showRelease: { selectDestination(.release) },
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
            .padding(ShannonDesktopSpacing.medium)

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
        ShannonDesktopWorkProjection(
            tasks: conversation.agentTasks,
            query: developmentTaskSearchText,
            filter: developmentTaskFilter
        )
    }

    var agentHostPreference: ShannonAgentRoutingPreference {
        get { ShannonAgentRoutingPreference(rawValue: agentHostPreferenceRawValue) ?? .auto }
        nonmutating set { agentHostPreferenceRawValue = newValue.rawValue }
    }

    var agentReasoningEffort: ShannonAgentReasoningEffort {
        get { ShannonAgentReasoningEffort(rawValue: agentReasoningRawValue) ?? .high }
        nonmutating set { agentReasoningRawValue = newValue.rawValue }
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
