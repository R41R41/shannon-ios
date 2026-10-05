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
                // 開発 and 配信 are pages of 作業; 設定 is the row under the list.
                switch destination.pillar {
                case .work: return .destination(.work)
                case .settings: return nil
                case .talk, .shannon: return .destination(destination)
                }
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
            showShannon: { selectDestination(.shannon) },
            showDevelopment: { selectDestination(.development) },
            showRelease: { selectDestination(.release) },
            showSettings: { selectDestination(.settings) },
            toggleOutline: { toggleAuxiliaryPanel(.outline) },
            toggleTaskInspector: {
                prepareTaskInspectorSelection()
                toggleAuxiliaryPanel(.task)
            },
            toggleFigure: { toggleAuxiliaryPanel(.figure) }
        )
    }

    /// 「すがた」 belongs beside Talk (decision 2026-10-03): elsewhere (シャノン, 作業, 設定) her panel
    /// is not shown, so the page keeps its width; it comes back with Talk. Closing it closes the panel.
    var inspectorIsPresented: Binding<Bool> {
        Binding(
            get: { showsInspector && DesktopAuxiliaryPanel.isShown(auxiliaryPanel, on: destination) },
            // Hidden only for this page: a close that the hiding itself reports must not turn the panel off.
            set: { shown in
                if DesktopAuxiliaryPanel.isShown(auxiliaryPanel, on: destination) { showsInspector = shown }
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
            .padding(.horizontal, ShannonDesktopSpacing.medium)
            .padding(.top, ShannonDesktopSpacing.large)
            .padding(.bottom, ShannonDesktopSpacing.medium)

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
            case .figure:
                ShannonTalkFigurePanel(conversation: conversation, memory: memory)
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
