import Foundation

/// Renderers consume operational state, not a made-up emotion or confidence.
/// Waterlight uses this now; another renderer can use the same frame later.
public struct ShannonVoiceEmbodimentFrame: Equatable, Sendable {
    public enum Attention: String, Sendable { case user, tool, response, rest }
    public let attention: Attention
    public let expression: ShannonExpressionDTO
    public let activity: ShannonDialogueActivity
    public let statusLabel: String

    public init(phase: ShannonRealtimeVoicePhase, pendingTools: Int, expression: ShannonExpressionDTO) {
        self.expression = pendingTools > 0 && phase == .thinking ? .thinking : expression
        activity = pendingTools > 0 && phase == .thinking ? .working : phase.dialogueActivity
        statusLabel = pendingTools > 0 && phase == .thinking ? "調べものを確認中" : phase.japaneseLabel
        if phase == .listening { attention = .user }
        else if pendingTools > 0 { attention = .tool }
        else if phase == .thinking || phase == .speaking { attention = .response }
        else { attention = .rest }
    }
}
