// Adapted from Swift Pieces "Thinking State" (registry/swift/ai/ThinkingState.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Rewritten for Shannon: keeps the expression avatar and Japanese label, uses the
// intelligence sky role for the sheen, and holds the sheen still under Reduce Motion.

import SwiftUI

/// Waiting state for a text reply. Reply-shaped line bars sit where the answer
/// will appear; a water-light sheen travels across them and elapsed seconds show
/// that work continues. Text and the accessibility label stay authoritative.
struct ShannonTypingIndicator: View {
    let expression: ShannonExpressionDTO
    var isSearchingMemory = false

    @Environment(\.colorScheme) var colorScheme
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @ScaledMetric(relativeTo: .body) var barHeight: CGFloat = 10
    @State private var startedAt = Date()

    static let sweepDuration: Double = 2.2

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        TimelineView(.periodic(from: startedAt, by: 1)) { context in
            let elapsed = ShannonThinkingElapsed.seconds(since: startedAt, now: context.date)
            HStack(alignment: .top, spacing: ShannonSpacing.small) {
                ShannonChatAvatarView(expression: expression, size: 54)
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                        Text(isSearchingMemory ? ShannonGeneratedStrings.talkSearchingMemory : ShannonGeneratedStrings.talkThinking)
                            .font(.callout)
                            .foregroundStyle(palette.textSecondary)
                        if let label = ShannonThinkingElapsed.label(seconds: elapsed) {
                            Text(label)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(palette.textSecondary)
                                .contentTransition(reduceMotion ? .identity : .numericText(value: Double(elapsed)))
                        }
                    }
                    .frame(minHeight: 28, alignment: .leading)
                    replyBars(palette)
                        .overlay {
                            if !reduceMotion {
                                sheen(palette).mask { replyBars(palette) }
                            }
                        }
                }
                .padding(.top, ShannonSpacing.small)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isSearchingMemory ? "シャノンが記憶を探しています" : "シャノンが考えています")
            .accessibilityValue(ShannonThinkingElapsed.label(seconds: elapsed).map { "\($0)経過" } ?? "")
        }
        .onAppear { startedAt = Date() }
    }

    /// Full, slightly short, and trailing short bars in the rhythm of a reply paragraph.
    private func replyBars(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: barHeight * 0.8) {
            ForEach(0..<3, id: \.self) { index in
                Capsule()
                    .fill(palette.subtleSurface)
                    .overlay { Capsule().stroke(palette.divider.opacity(0.5), lineWidth: 0.5) }
                    .frame(height: barHeight)
                    .padding(.trailing, [0, 32, 96][index])
            }
        }
        .frame(maxWidth: 280, alignment: .leading)
        .accessibilityHidden(true)
    }

    private func sheen(_ palette: ShannonPalette) -> some View {
        TimelineView(.animation) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let sweep = time.truncatingRemainder(dividingBy: Self.sweepDuration) / Self.sweepDuration
            ShannonThinkingSheen(sweep: sweep, color: palette.intelligenceSky, strength: colorScheme == .dark ? 0.55 : 0.75)
        }
        .allowsHitTesting(false)
    }
}

enum ShannonThinkingElapsed {
    static func seconds(since start: Date, now: Date) -> Int {
        max(0, Int(now.timeIntervalSince(start)))
    }

    /// Hidden for the first second so a fast reply never flashes "0秒".
    static func label(seconds: Int) -> String? {
        seconds >= 1 ? "\(seconds)秒" : nil
    }
}

/// One soft band traveling leading to trailing. `sweep` is 0...1 across one pass.
struct ShannonThinkingSheen: View {
    let sweep: Double
    let color: Color
    let strength: Double

    var body: some View {
        let center = -0.4 + sweep * 1.8
        LinearGradient(
            stops: [
                .init(color: color.opacity(0), location: clamp(center - 0.25)),
                .init(color: color.opacity(strength), location: clamp(center)),
                .init(color: color.opacity(0), location: clamp(center + 0.25)),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    private func clamp(_ value: Double) -> Double { min(max(value, 0), 1) }
}
