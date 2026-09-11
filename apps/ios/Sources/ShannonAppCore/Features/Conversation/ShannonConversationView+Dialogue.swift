import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func dialogueStage(_ palette: M3Palette) -> some View {
        GeometryReader { geometry in
            let keyboardScale: CGFloat = composerIsFocused ? 0.84 : 1
            let portraitWidth = min(geometry.size.width * 1.04, 430) * keyboardScale

            ZStack(alignment: .top) {
                LinearGradient(
                    colors: [
                        palette.surface,
                        palette.intelligenceSoft.opacity(colorScheme == .dark ? 0.42 : 0.56),
                        palette.surface
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

                ShannonDialogueStagePortraitView()
                    .frame(width: portraitWidth)
                    .scaleEffect(dialoguePresenceIsBreathing && !reduceMotion ? 1.008 : 1)
                    .shadow(color: palette.brandPresence.opacity(0.14), radius: 28, y: 10)
                    .position(
                        x: geometry.size.width / 2,
                        y: geometry.size.height * (composerIsFocused ? 0.59 : 0.62)
                    )
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.24), value: composerIsFocused)
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: 3.2).repeatForever(autoreverses: true),
                        value: dialoguePresenceIsBreathing
                    )

                VStack(spacing: M3Spacing.small) {
                    HStack(spacing: 6) {
                        Text("シャノン")
                            .font(.callout.weight(.semibold))
                        Text("·")
                        Text(model.currentExpression.japaneseName)
                    }
                    .foregroundStyle(palette.onSurfaceVariant)
                    .padding(.horizontal, M3Spacing.medium)
                    .frame(minHeight: 32)
                    .background(.thinMaterial, in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("シャノン、\(model.currentExpression.japaneseName)")

                    if let userMessage = latestUserMessage {
                        Text("あなた：\(userMessage.text)")
                            .font(.caption)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .lineLimit(1)
                            .padding(.horizontal, M3Spacing.medium)
                            .frame(maxWidth: 330, minHeight: 30, alignment: .trailing)
                            .background(.ultraThinMaterial, in: Capsule())
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .padding(.horizontal, M3Spacing.large)
                    }

                    if model.isSending {
                        ShannonDialogueBubble(palette: palette, isExpanded: false) {
                            ShannonThinkingDots()
                        }
                        .transition(.opacity)
                    } else if let reply = model.messages.last(where: { $0.role == .shannon }) {
                        ShannonDialogueBubble(palette: palette, isExpanded: dialogueIsExpanded) {
                            VStack(alignment: .leading, spacing: M3Spacing.extraSmall) {
                                ScrollView(dialogueIsExpanded ? .vertical : []) {
                                    Text(reply.text)
                                        .font(.body)
                                        .lineSpacing(2)
                                        .foregroundStyle(palette.onSurface)
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .scrollIndicators(.hidden)
                                .frame(maxHeight: dialogueIsExpanded ? min(250, geometry.size.height * 0.34) : 104)

                                HStack(spacing: M3Spacing.extraSmall) {
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
                                        .foregroundStyle(palette.onSurfaceVariant)
                                    }
                                    Spacer(minLength: 0)
                                    Button {
                                        copyDialogueReply(reply.text)
                                    } label: {
                                        Label(
                                            dialogueDidCopy ? "コピー済み" : "コピー",
                                            systemImage: dialogueDidCopy ? "checkmark" : "doc.on.doc"
                                        )
                                        .font(.caption2.weight(.semibold))
                                        .frame(minHeight: 30)
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(palette.onSurfaceVariant)
                                    .accessibilityLabel(dialogueDidCopy ? "コピーしました" : "シャノンの回答をコピー")
                                }
                            }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, ShannonWorkspaceChrome.contentTopInset + 48)
                .padding(.bottom, M3Spacing.large)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { composerIsFocused = false }
        .onAppear { dialoguePresenceIsBreathing = true }
        .onDisappear { dialoguePresenceIsBreathing = false }
        .onChange(of: model.messages.count) { dialogueIsExpanded = false }
    }
}
