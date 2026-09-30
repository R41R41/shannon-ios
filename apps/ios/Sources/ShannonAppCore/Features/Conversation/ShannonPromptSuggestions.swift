// Chip presentation adapted from Swift Pieces "Prompt Chips" (registry/swift/ai/PromptChips.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Rewritten for Shannon: suggestions come only from state the client already holds,
// choosing a chip fills the composer without sending, and there is no morph animation.

import SwiftUI

/// Topic suggestions for an empty conversation, derived only from already-loaded client state.
public enum ShannonPromptSuggestions {
    public struct Suggestion: Equatable, Identifiable, Sendable {
        public enum Source: Equatable, Sendable {
            case dailyMind
            case activeTask
            case interest
            case fallback
        }

        public let text: String
        public let symbol: String
        public let source: Source
        public var id: String { text }
    }

    public static let maximumCount = 4

    public static let fallback: [Suggestion] = [
        Suggestion(text: "今日やることを一緒に整理したい", symbol: "checklist", source: .fallback),
        Suggestion(text: "いま考えていることの壁打ちをしてほしい", symbol: "bubble.left.and.bubble.right", source: .fallback),
        Suggestion(text: "最近どうだったか聞いてほしい", symbol: "cup.and.saucer", source: .fallback),
    ]

    public static func make(
        dailyMindTopic: String?,
        activeTaskTitles: [String],
        interests: [String]
    ) -> [Suggestion] {
        var result: [Suggestion] = []
        func append(_ suggestion: Suggestion) {
            guard result.count < maximumCount, !result.contains(where: { $0.text == suggestion.text }) else { return }
            result.append(suggestion)
        }

        if let topic = clean(dailyMindTopic) {
            append(Suggestion(text: "「\(topic)」について話したい", symbol: "sparkles", source: .dailyMind))
        }
        if let task = activeTaskTitles.lazy.compactMap(clean).first {
            append(Suggestion(text: "「\(task)」の進み具合を教えて", symbol: "hammer", source: .activeTask))
        }
        for interest in interests.compactMap(clean).prefix(2) {
            append(Suggestion(text: "\(interest)の話をしよう", symbol: "lightbulb", source: .interest))
        }
        if result.isEmpty { return fallback }
        for suggestion in fallback where result.count < 3 { append(suggestion) }
        return result
    }

    static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let collapsed = value.split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty else { return nil }
        return collapsed.count > 24 ? String(collapsed.prefix(23)) + "…" : collapsed
    }
}

/// Horizontal suggestion row placed above the composer on an empty conversation.
struct ShannonPromptChipRow: View {
    let suggestions: [ShannonPromptSuggestions.Suggestion]
    let palette: ShannonPalette
    let choose: (ShannonPromptSuggestions.Suggestion) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealed = false
    @State private var chosenCount = 0

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: ShannonSpacing.small) {
                ForEach(Array(suggestions.enumerated()), id: \.element.id) { index, suggestion in
                    Button {
                        chosenCount += 1
                        choose(suggestion)
                    } label: {
                        HStack(spacing: ShannonSpacing.small) {
                            Image(systemName: suggestion.symbol)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(palette.action)
                                .frame(width: 28, height: 28)
                                .background(palette.action.opacity(0.12), in: Circle())
                                .accessibilityHidden(true)
                            Text(suggestion.text)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(palette.textPrimary)
                                .lineLimit(1)
                        }
                        .padding(.leading, 6)
                        .padding(.trailing, ShannonSpacing.medium)
                        .frame(minHeight: ShannonTouchTarget.minimum)
                        .background(palette.elevatedSurface, in: Capsule())
                        .overlay { Capsule().stroke(palette.divider.opacity(0.8), lineWidth: 0.7) }
                        .contentShape(Capsule())
                    }
                    .buttonStyle(ShannonChipPressStyle(reduceMotion: reduceMotion))
                    .opacity(revealed || reduceMotion ? 1 : 0)
                    .offset(y: revealed || reduceMotion ? 0 : 6)
                    .animation(
                        reduceMotion ? nil : .spring(duration: 0.4, bounce: 0).delay(Double(index) * 0.05),
                        value: revealed
                    )
                    .accessibilityHint("入力欄に入れます。送信はしません")
                }
            }
            .scrollTargetLayout()
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
        .scrollTargetBehavior(.viewAligned)
        .contentMargins(.horizontal, ShannonSpacing.medium, for: .scrollContent)
        .sensoryFeedback(.selection, trigger: chosenCount)
        .onAppear { revealed = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("話題の候補")
    }
}

/// Immediate press response with a short, damped release.
struct ShannonChipPressStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.7 : 1)
            .animation(
                configuration.isPressed ? .easeOut(duration: 0.08) : .spring(duration: 0.3, bounce: 0),
                value: configuration.isPressed
            )
    }
}
