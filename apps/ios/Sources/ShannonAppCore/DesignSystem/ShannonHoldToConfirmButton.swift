// Adapted from Swift Pieces "Hold To Confirm" (registry/swift/controls/HoldToConfirm.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Rewritten for Shannon: a native Button whose tap (and VoiceOver activation) opens a
// confirmation dialog, plus a short hold that commits directly. Semantic palette,
// no milestone dots, and a text-and-percentage state under Reduce Motion.

import SwiftUI

enum ShannonHoldToConfirm {
    /// Short enough not to slow deliberate approvals, long enough to prevent accidental commits.
    static let defaultDuration: Double = 0.6

    static func progress(startedAt: Date?, now: Date, duration: Double = defaultDuration) -> Double {
        guard let startedAt, duration > 0 else { return 0 }
        return min(max(now.timeIntervalSince(startedAt) / duration, 0), 1)
    }
}

/// Commits after a short hold. A tap, keyboard activation, or VoiceOver activation
/// opens a confirmation dialog instead, so the action never depends on holding.
struct ShannonHoldToConfirmButton: View {
    enum Prominence {
        case prominent
        case standard
    }

    let title: String
    let prominence: Prominence
    let confirmationTitle: String
    let confirmationMessage: String
    let confirmActionTitle: String
    var holdDuration = ShannonHoldToConfirm.defaultDuration
    let action: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @GestureState private var isPressing = false
    @State private var pressStartedAt: Date?
    @State private var committedAt: Date?
    @State private var showsConfirmation = false
    @State private var commitCount = 0

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        Button {
            // A completed hold may also deliver a tap on release; it must not ask again.
            if let committedAt, Date().timeIntervalSince(committedAt) < 1 { return }
            showsConfirmation = true
        } label: {
            TimelineView(.animation(minimumInterval: reduceMotion ? 0.1 : nil, paused: pressStartedAt == nil)) { context in
                let progress = ShannonHoldToConfirm.progress(
                    startedAt: pressStartedAt, now: context.date, duration: holdDuration
                )
                label(palette, progress: progress)
            }
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: holdDuration, maximumDistance: 24)
                .updating($isPressing) { _, state, _ in state = true }
                .onEnded { _ in commit() }
        )
        .onChange(of: isPressing) { _, pressing in
            if pressing, isEnabled {
                pressStartedAt = Date()
            } else if !pressing {
                withAnimation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0)) { pressStartedAt = nil }
            }
        }
        .sensoryFeedback(.success, trigger: commitCount)
        .confirmationDialog(confirmationTitle, isPresented: $showsConfirmation, titleVisibility: .visible) {
            Button(confirmActionTitle, action: action)
            Button("戻る", role: .cancel) {}
        } message: {
            Text(confirmationMessage)
        }
        .accessibilityLabel(title)
        .accessibilityHint("長押しで決定します。タップすると確認してから決定します")
    }

    private func label(_ palette: ShannonPalette, progress: Double) -> some View {
        let isProminent = prominence == .prominent
        let foreground = isProminent ? palette.onAction : palette.action
        let isHolding = pressStartedAt != nil
        let text = reduceMotion && isHolding
            ? "押し続けています… \(Int(progress * 100))%"
            : title

        return HStack(spacing: ShannonSpacing.small) {
            Image(systemName: "hand.tap")
                .font(.callout.weight(.semibold))
                .accessibilityHidden(true)
            Text(text)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .monospacedDigit()
        }
        .font(.body.weight(.semibold))
        .foregroundStyle(foreground)
        .padding(.horizontal, ShannonSpacing.large)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background {
            ZStack(alignment: .leading) {
                Capsule().fill(isProminent ? palette.action : palette.action.opacity(0.14))
                if !reduceMotion {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(isProminent ? palette.onAction.opacity(0.28) : palette.action.opacity(0.24))
                            .frame(width: proxy.size.width * progress)
                    }
                }
            }
            .clipShape(Capsule())
        }
        .overlay {
            if reduceMotion && isHolding {
                Capsule().strokeBorder(foreground.opacity(0.6), lineWidth: 2)
            }
        }
        .contentShape(Capsule())
        .opacity(isEnabled ? 1 : 0.45)
    }

    private func commit() {
        guard isEnabled else { return }
        committedAt = Date()
        pressStartedAt = nil
        commitCount += 1
        action()
    }
}
