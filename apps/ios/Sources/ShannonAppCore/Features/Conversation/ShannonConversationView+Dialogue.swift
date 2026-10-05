import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    /// The dialogue display is where her figure lives (decision 2026-10-03: からだ is a display of Talk).
    /// The Live2D form: her figure on top, large and touchable in place, the line of what she feels and
    /// does under her, then the last words. The Waterlight form keeps the stage as it was.
    var dialogueShowsLive2D: Bool { formRawValue == ShannonForm.live2d.rawValue }

    func dialogueStage(_ palette: ShannonPalette) -> some View {
        GeometryReader { stage in
            ZStack(alignment: .top) {
                dialogueBackground(palette, size: stage.size)
                VStack(spacing: 0) {
                    // The camera's state, always there over the dialogue display (A7): 切／見てよい／いま見ています.
                    HStack {
                        Spacer(minLength: 0)
                        ShannonAppLookStateBadge(coordinator: model.appLook, othersPresent: cameraOthersPresent)
                    }
                    .padding(.horizontal, ShannonSpacing.large)
                    .padding(.top, ShannonSpacing.extraSmall)
                    GeometryReader { geometry in
                        if dialogueShowsLive2D {
                            live2DDialogue(palette, geometry: geometry)
                        } else {
                            waterlightDialogue(palette, geometry: geometry)
                                .contentShape(Rectangle())
                                .onTapGesture { composerIsFocused = false }
                        }
                    }
                }
            }
        }
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

    private func dialogueBackground(_ palette: ShannonPalette, size: CGSize) -> some View {
        ZStack {
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
                .frame(width: size.width * 1.28, height: size.width * 1.28)
                .blur(radius: 42)
                .position(x: size.width / 2, y: size.height * 0.50)
        }
        // Taps on the empty stage put the keyboard away; a finger on her figure stays hers.
        .contentShape(Rectangle())
        .onTapGesture { composerIsFocused = false }
    }

    // MARK: The Live2D form

    private func live2DDialogue(_ palette: ShannonPalette, geometry: GeometryProxy) -> some View {
        VStack(spacing: ShannonSpacing.small) {
            ShannonDialogueFigure(face: model.currentFace, activity: dialogueActivity)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // 「いま：〈気持ち〉・〈していること〉」, as the body screen said it under her.
            Text(ShannonBodyCopy.nowLine(face: bodyModel.face, doing: bodyModel.doingLine))
                .font(.shannon(.callout))
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, ShannonSpacing.medium)
                .frame(minHeight: 32)
                .background(.thinMaterial, in: Capsule())
                .padding(.horizontal, ShannonSpacing.large)
                .accessibilityIdentifier("body-now-line")

            dialogueUserLine(palette)
            dialogueReply(palette, geometry: geometry)
        }
        .padding(.top, ShannonSpacing.small)
        .padding(.bottom, ShannonSpacing.large)
        // What she is doing in her own time, read as the body screen read it while her figure is in front.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await memoryModel.autonomy.refreshQuietly()
                await memoryModel.autonomy.study.refreshQuietly()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    // MARK: The Waterlight form

    private func waterlightDialogue(_ palette: ShannonPalette, geometry: GeometryProxy) -> some View {
        let keyboardScale: CGFloat = composerIsFocused ? 0.84 : 1
        let hasReply = model.messages.contains(where: { $0.role == .shannon })
        let faceScale: CGFloat = hasReply ? 0.44 : 0.70
        let faceLimit: CGFloat = hasReply ? 190 : 292
        let faceSize = min(geometry.size.width * faceScale, faceLimit) * keyboardScale

        return ZStack(alignment: .top) {
            ShannonBodyView(
                expression: model.currentExpression,
                activity: dialogueActivity,
                size: faceSize,
                feeling: model.currentFace.feeling
            )
                .shadow(color: palette.brandPresence.opacity(0.14), radius: 28, y: 10)
                .position(
                    x: geometry.size.width / 2,
                    y: geometry.size.height * (composerIsFocused ? 0.70 : 0.74)
                )
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.24), value: composerIsFocused)

            VStack(spacing: ShannonSpacing.small) {
                if !dynamicTypeSize.isAccessibilitySize {
                    HStack(spacing: 6) {
                        Text("シャノン")
                            .font(.shannon(.callout).weight(.semibold))
                        Text("·")
                        Text(model.currentFace.japaneseName)
                    }
                    .foregroundStyle(palette.textSecondary)
                    .padding(.horizontal, ShannonSpacing.medium)
                    .frame(minHeight: 32)
                    .background(.thinMaterial, in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(model.currentFace.accessibilityDescription)
                }
                dialogueUserLine(palette)
                dialogueReply(palette, geometry: geometry)
                Spacer(minLength: 0)
            }
            .padding(.top, ShannonSpacing.large)
            .padding(.bottom, ShannonSpacing.large)
        }
    }

    // MARK: The words

    @ViewBuilder
    private func dialogueUserLine(_ palette: ShannonPalette) -> some View {
        if !dynamicTypeSize.isAccessibilitySize, let userMessage = latestUserMessage {
            Text("あなた：\(userMessage.text)")
                .font(.shannon(.caption))
                .foregroundStyle(palette.textSecondary)
                .lineLimit(2)
                .padding(.horizontal, ShannonSpacing.medium)
                .frame(maxWidth: 330, minHeight: 30, alignment: .trailing)
                .background(.ultraThinMaterial, in: Capsule())
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, ShannonSpacing.large)
        }
    }

    @ViewBuilder
    private func dialogueReply(_ palette: ShannonPalette, geometry: GeometryProxy) -> some View {
        if model.isSending {
            ShannonDialogueBubble(palette: palette, isExpanded: false) {
                ShannonThinkingDots()
            }
            .transition(.opacity)
        } else if let reply = model.messages.last(where: { $0.role == .shannon }) {
            ShannonDialogueBubble(
                palette: palette,
                isExpanded: dialogueIsExpanded,
                maxWidth: min(560, geometry.size.width - 32)
            ) {
                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                    ScrollView(dialogueIsExpanded ? .vertical : []) {
                        ShannonRichMarkdownText(source: reply.text, palette: palette)
                            .textSelection(.enabled)
                        if ShannonTurnCaptureList.hasContent(reply) {
                            ShannonTurnCaptureList(message: reply, conversation: model, memory: memoryModel)
                        }
                    }
                    .scrollIndicators(.hidden)
                    .frame(
                        maxHeight: dialogueIsExpanded
                            ? min(360, geometry.size.height * 0.48)
                            : (dynamicTypeSize.isAccessibilitySize ? 180 : 156)
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
                                .font(.shannon(.caption2).weight(.medium))
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
                            .font(.shannon(.caption2).weight(.semibold))
                            .frame(
                                minWidth: ShannonTouchTarget.minimum,
                                minHeight: ShannonTouchTarget.minimum
                            )
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityLabel(dialogueDidCopy ? "コピーしました" : "シャノンの回答をコピー")
                    }
                    Button {
                        toggleDisplayMode()
                    } label: {
                        Label("会話全体を読む", systemImage: "text.bubble")
                            .font(.shannon(.caption).weight(.semibold))
                            .frame(minHeight: ShannonTouchTarget.minimum)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(palette.action)
                }
            }
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }
}
