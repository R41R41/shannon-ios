import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    var workspaceNavigationTitle: String {
        guard selectedPage == .talk else { return selectedPage.title }
        return model.threads.first(where: { $0.threadId == model.selectedThreadId })?.title ?? "トーク"
    }

    @ToolbarContentBuilder
    var workspaceToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button(action: openThreadList) {
                Image(systemName: "sidebar.left")
            }
            .accessibilityLabel("トークと画面を開く")
            .accessibilityValue(model.totalBadgeCount > 0 ? "未確認(model.totalBadgeCount)件" : "未確認なし")
            .overlay(alignment: .topTrailing) {
                if model.totalBadgeCount > 0 {
                    Circle()
                        .fill(ShannonPalette.resolve(resolvedColorScheme).danger)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
            }
        }

        if selectedPage == .talk {
            ToolbarItemGroup(placement: .primaryAction) {
                Button(action: toggleDisplayMode) {
                    Image(systemName: displayMode.switchActionSymbolName)
                }
                .accessibilityLabel("\(displayMode.switchActionTitle)表示へ切り替える")

                Button(action: createThreadFromHeader) {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("新しいトーク")
            }
        }
    }

    func workspaceContent(_ palette: ShannonPalette) -> some View {
        Group {
            switch selectedPage {
            case .talk:
                talkPage(palette)
            case .work:
            ShannonAgentTaskOverviewView(model: model, openTask: openAgentTask)
            case .memory:
            ShannonMemoryView(
                model: memoryModel,
                showsDismissButton: false,
                workspaceTopInset: 0
            )
            }
        }
    }

    func talkPage(_ palette: ShannonPalette) -> some View {
        ZStack {
            Group {
                switch displayMode {
                case .scroll:
                    messageList(palette)
                case .dialogue:
                    dialogueStage(palette)
                }
            }

        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: ShannonSpacing.small) {
                if let statusMessage = model.statusMessage {
                    ShannonSnackbar(
                        message: statusMessage,
                        showsRetry: false,
                        retry: {},
                        dismiss: model.dismissStatus
                    )
                    .padding(.horizontal, ShannonSpacing.large)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if let errorMessage = model.errorMessage {
                    ShannonSnackbar(
                        message: errorMessage,
                        showsRetry: model.hasFailedMessage,
                        retry: { Task { await model.retryLastFailed() } },
                        dismiss: model.dismissError
                    )
                    .padding(.horizontal, ShannonSpacing.large)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if let task = model.latestAgentTaskNotice {
                    ShannonAgentTaskCapsule(task: task) {
                        openAgentTask(task.id)
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if voiceModel.phase != .idle {
                    ShannonVoiceStatusBar(
                        model: voiceModel,
                        primaryAction: performTranscriptionPrimaryAction,
                        cancel: voiceModel.cancel
                    )
                    .padding(.horizontal, ShannonSpacing.medium)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                composer(palette)
            }
            .background(.bar)
        }
        .background(palette.canvas)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
    }
}
