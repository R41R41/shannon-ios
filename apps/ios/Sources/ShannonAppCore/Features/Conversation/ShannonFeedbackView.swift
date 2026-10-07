import SwiftUI

/// A quiet response control. A casual reply without a server target contributes no row.
public struct ShannonFeedbackView: View {
    let target: ShannonFeedbackDTO
    @Bindable var model: ShannonFeedbackModel
    @Environment(\.colorScheme) private var colorScheme
    public init(target: ShannonFeedbackDTO, model: ShannonFeedbackModel) { self.target = target; self.model = model }
    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        if let current = model.state(for: target) {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                HStack(spacing: ShannonSpacing.extraSmall) {
                    reactionButton(.good, title: "役に立った", symbol: "hand.thumbsup", current: current, palette: palette)
                    reactionButton(.bad, title: "役に立たなかった", symbol: "hand.thumbsdown", current: current, palette: palette)
                    if model.pending[target.targetId] != nil {
                        Text("確認中").font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    }
                }
                if let notice = model.notices[target.targetId] {
                    Text(notice).font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
                    Button("確認する") { Task { await model.check(target) } }
                        .frame(minHeight: ShannonTouchTarget.minimum)
                        .disabled(model.pending[target.targetId]?.checking == false)
                }
            }
            .tint(palette.action)
            .accessibilityIdentifier("feedback-\(target.targetId)")
        }
    }
    private func reactionButton(_ reaction: ShannonFeedbackReaction, title: String, symbol: String,
                                current: ShannonFeedbackDTO, palette: ShannonPalette) -> some View {
        Button { Task { await model.choose(reaction, target: current) } } label: {
            Image(systemName: symbol + (current.reaction == reaction ? ".fill" : ""))
                .frame(minWidth: ShannonTouchTarget.minimum, minHeight: ShannonTouchTarget.minimum)
                .foregroundStyle(current.reaction == reaction ? palette.action : palette.textSecondary)
        }
        .buttonStyle(.plain)
        .disabled(model.pending[target.targetId] != nil || !model.freshTargets.contains(target.targetId))
        .accessibilityLabel(title)
        .accessibilityValue(current.reaction == reaction ? "選択済み" : "未選択")
        .accessibilityHint(current.reaction == reaction ? "もう一度押すと取り消します" : "この返答への反応を伝えます")
    }
}
