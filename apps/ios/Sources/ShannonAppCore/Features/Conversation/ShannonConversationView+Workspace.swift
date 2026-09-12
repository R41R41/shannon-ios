import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func workspaceContent(
        _ palette: ShannonPalette,
        bottomSafeAreaInset: CGFloat
    ) -> some View {
        ZStack {
            talkPage(palette, bottomSafeAreaInset: bottomSafeAreaInset)
                .opacity(selectedPage == .talk ? 1 : 0)
                .allowsHitTesting(selectedPage == .talk)
                .accessibilityHidden(selectedPage != .talk)
            ShannonAgentTaskOverviewView(model: model, openTask: openAgentTask)
                .opacity(selectedPage == .work ? 1 : 0)
                .allowsHitTesting(selectedPage == .work)
                .accessibilityHidden(selectedPage != .work)
            ShannonMemoryView(
                model: memoryModel,
                showsDismissButton: false,
                workspaceTopInset: ShannonWorkspaceChrome.contentTopInset
            )
            .ignoresSafeArea(.container, edges: [.top, .bottom])
            .opacity(selectedPage == .memory ? 1 : 0)
            .allowsHitTesting(selectedPage == .memory)
            .accessibilityHidden(selectedPage != .memory)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: selectedPage)
    }

    func talkPage(
        _ palette: ShannonPalette,
        bottomSafeAreaInset: CGFloat
    ) -> some View {
        ZStack {
            Group {
                switch displayMode {
                case .scroll:
                    messageList(palette)
                case .dialogue:
                    dialogueStage(palette)
                }
            }

            VStack {
                HStack {
                    Spacer()
                    Button(action: toggleDisplayMode) {
                        Label(displayMode.switchActionTitle, systemImage: displayMode.switchActionSymbolName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.textSecondary)
                            .padding(.horizontal, ShannonSpacing.medium)
                            .frame(minHeight: 38)
                            .background(.thinMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(displayMode.switchActionTitle)表示へ切り替える")
                }
                .padding(.horizontal, ShannonSpacing.large)
                .padding(.top, ShannonWorkspaceChrome.contentTopInset)
                Spacer()
            }
        }
        .overlay(alignment: .bottom) {
            ZStack(alignment: .bottom) {
                ShannonBottomReadabilityGradient(
                    palette: palette,
                    bottomSafeAreaInset: bottomSafeAreaInset
                )
                    .offset(y: bottomSafeAreaInset)
                    .allowsHitTesting(false)
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
            }
        }
        .background(palette.canvas)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
    }
}
