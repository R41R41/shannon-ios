import Foundation

@MainActor
struct ShannonConversationCache {
    struct Snapshot: Codable, Sendable {
        var threads: [ChatThreadDTO]
        var selectedThreadId: String?
        var histories: [String: [CachedMessage]]
        var state: CompanionStateDTO?
    }

    struct CachedMessage: Codable, Sendable {
        let id: UUID
        let role: String
        let text: String
        let sentAt: Date
        let deliveryState: String
        let emotionSnapshot: CachedEmotion?
        let artifacts: [ShannonGeneratedArtifactDTO]?
        let sourceAttribution: ShannonSourceAttributionDTO?
        let turnID: String?
        let captures: [ShannonTurnCaptureDTO]?
        let reminder: ShannonReminderDTO?

        init(_ message: ConversationMessage) {
            turnID = message.turnID
            captures = message.captures.isEmpty ? nil : message.captures
            reminder = message.reminder
            id = message.id
            role = message.role == .user ? "user" : "shannon"
            text = message.text
            sentAt = message.sentAt
            switch message.deliveryState {
            case .sending: deliveryState = "sending"
            case .sent: deliveryState = "sent"
            case .failed: deliveryState = "failed"
            }
            emotionSnapshot = message.emotionSnapshot.map(CachedEmotion.init)
            artifacts = message.artifacts.isEmpty ? nil : message.artifacts
            sourceAttribution = message.sourceAttribution
        }

        var message: ConversationMessage {
            ConversationMessage(
                id: id,
                role: role == "user" ? .user : .shannon,
                text: text,
                sentAt: sentAt,
                deliveryState: deliveryState == "failed" ? .failed : .sent,
                emotionSnapshot: emotionSnapshot?.value,
                artifacts: artifacts ?? [],
                sourceAttribution: sourceAttribution,
                turnID: turnID,
                captures: captures ?? [],
                reminder: reminder
            )
        }
    }

    struct CachedEmotion: Codable, Sendable {
        let valence: Double
        let arousal: Double
        let openness: Double
        let expression: ShannonExpressionDTO
        let stateVersion: Int

        init(_ value: ConversationMessage.EmotionSnapshot) {
            valence = value.valence
            arousal = value.arousal
            openness = value.openness
            expression = value.expression
            stateVersion = value.stateVersion
        }

        var value: ConversationMessage.EmotionSnapshot {
            .init(
                valence: valence,
                arousal: arousal,
                openness: openness,
                expression: expression,
                stateVersion: stateVersion
            )
        }
    }

    private let defaults: UserDefaults
    private let prefix = "shannon.conversation-cache.v1."

    static let standard = ShannonConversationCache(defaults: .standard)

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    func load(scopeKey: String) -> Snapshot? {
        guard let data = defaults.data(forKey: prefix + scopeKey) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    func save(_ snapshot: Snapshot, scopeKey: String) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: prefix + scopeKey)
    }
}
