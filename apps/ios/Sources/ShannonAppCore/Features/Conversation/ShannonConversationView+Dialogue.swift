import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func dialogueStage(_ palette: ShannonPalette) -> some View {
        GeometryReader { geometry in
            let keyboardScale: CGFloat = composerIsFocused ? 0.84 : 1
            let faceSize = min(geometry.size.width * 0.70, 292) * keyboardScale

            ZStack(alignment: .top) {
                LinearGradient(
                    colors: [
                        palette.canvas,
                        palette.intelligenceSoft.opacity(colorScheme == .dark ? 0.42 : 0.56),
                        palette.canvas
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()

                Circle()
                    .fill(palette.intelligenceGradient)
                    .opacity(colorScheme == .dark ? 0.18 : 0.12)
                    .frame(width: geometry.size.width * 1.28, height: geometry.size.width * 1.28)
                    .blur(radius: 42)
                    .position(x: geometry.size.width / 2, y: geometry.size.height * 0.50)

                ShannonWaterlightEyeView(
                    expression: model.currentExpression,
                    activity: dialogueActivity,
                    size: faceSize
                )
                    .shadow(color: palette.brandPresence.opacity(0.14), radius: 28, y: 10)
                    .position(
                        x: geometry.size.width / 2,
                        y: geometry.size.height * (composerIsFocused ? 0.60 : 0.62)
                    )
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.24), value: composerIsFocused)

                VStack(spacing: ShannonSpacing.small) {
                    if !dynamicTypeSize.isAccessibilitySize {
                        HStack(spacing: 6) {
                            Text("シャノン")
                                .font(.callout.weight(.semibold))
                            Text("·")
                            Text(model.currentExpression.japaneseName)
                        }
                        .foregroundStyle(palette.textSecondary)
                        .padding(.horizontal, ShannonSpacing.medium)
                        .frame(minHeight: 32)
                        .background(.thinMaterial, in: Capsule())
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("シャノン、\(model.currentExpression.japaneseName)")

                        if let userMessage = latestUserMessage {
                            Text("あなた：\(userMessage.text)")
                                .font(.caption)
                                .foregroundStyle(palette.textSecondary)
                                .lineLimit(1)
                                .padding(.horizontal, ShannonSpacing.medium)
                                .frame(maxWidth: 330, minHeight: 30, alignment: .trailing)
                                .background(.ultraThinMaterial, in: Capsule())
                                .frame(maxWidth: .infinity, alignment: .trailing)
                                .padding(.horizontal, ShannonSpacing.large)
                        }
                    }

                    if model.isSending {
                        ShannonDialogueBubble(palette: palette, isExpanded: false) {
                            ShannonThinkingDots()
                        }
                        .transition(.opacity)
                    } else if let reply = model.messages.last(where: { $0.role == .shannon }) {
                        ShannonDialogueBubble(palette: palette, isExpanded: dialogueIsExpanded) {
                            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                                ScrollView(dialogueIsExpanded ? .vertical : []) {
                                    Text(reply.text)
                                        .font(.body)
                                        .lineSpacing(2)
                                        .foregroundStyle(palette.textPrimary)
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .scrollIndicators(.hidden)
                                .frame(
                                    maxHeight: dialogueIsExpanded
                                        ? min(250, geometry.size.height * 0.34)
                                        : (dynamicTypeSize.isAccessibilitySize ? 132 : 104)
                                )

                                HStack(spacing: ShannonSpacing.extraSmall) {
                                    if reply.text.count > 120 {
                                        Button {
                                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.24)) {
                                                dialogueIsExpanded.toggle()
                                            }
                                        } label: {
                                            Label(
                                                dialogueIsExpanded ? "閉じる" : "続きを読む",
                                                systemImage: dialogueIsExpanded ? "chevron.up" : "chevron.down"
                                            )
                                            .font(.caption2.weight(.medium))
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(palette.textSecondary)
                                    }
                                    Spacer(minLength: 0)
                                    Button {
                                        copyDialogueReply(reply.text)
                                    } label: {
                                        Group {
                                            if dynamicTypeSize.isAccessibilitySize {
                                                Image(systemName: dialogueDidCopy ? "checkmark" : "doc.on.doc")
                                            } else {
                                                Label(
                                                    dialogueDidCopy ? "コピー済み" : "コピー",
                                                    systemImage: dialogueDidCopy ? "checkmark" : "doc.on.doc"
                                                )
                                            }
                                        }
                                        .font(.caption2.weight(.semibold))
                                        .frame(minWidth: 30, minHeight: 30)
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(palette.textSecondary)
                                    .accessibilityLabel(dialogueDidCopy ? "コピーしました" : "シャノンの回答をコピー")
                                }
                            }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, ShannonSpacing.large)
                .padding(.bottom, ShannonSpacing.large)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { composerIsFocused = false }
        .onAppear { dialogueActivity = model.isSending ? .thinking : .idle }
        .onChange(of: model.isSending) { _, isSending in
            if isSending {
                dialogueActivity = .thinking
            } else {
                dialogueActivity = model.errorMessage == nil ? .speaking : .failed
            }
        }
        .task(id: dialogueActivity) {
            guard dialogueActivity == .speaking else { return }
            try? await Task.sleep(for: .seconds(1.8))
            guard !Task.isCancelled, !model.isSending else { return }
            dialogueActivity = .idle
        }
        .onChange(of: model.messages.count) { dialogueIsExpanded = false }
    }
}
