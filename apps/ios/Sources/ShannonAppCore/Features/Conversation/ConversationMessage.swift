import Foundation

public struct ConversationMessage: Equatable, Identifiable, Sendable {
    public enum Role: Equatable, Sendable {
        case user
        case shannon
    }

    public enum DeliveryState: Equatable, Sendable {
        case sending
        case sent
        case failed
    }

    public struct EmotionSnapshot: Equatable, Sendable {
        public let valence: Double
        public let arousal: Double
        public let openness: Double
        public let expression: ShannonExpressionDTO
        public let stateVersion: Int

        public init(
            valence: Double,
            arousal: Double,
            openness: Double,
            expression: ShannonExpressionDTO,
            stateVersion: Int
        ) {
            self.valence = valence
            self.arousal = arousal
            self.openness = openness
            self.expression = expression
            self.stateVersion = stateVersion
        }
    }

    public let id: UUID
    public let role: Role
    public let text: String
    public let sentAt: Date
    public let deliveryState: DeliveryState
    public let emotionSnapshot: EmotionSnapshot?
    public let artifacts: [ShannonGeneratedArtifactDTO]
    public let sourceAttribution: ShannonSourceAttributionDTO?
    public let places: [ShannonPlaceDTO]

    public init(
        id: UUID = UUID(),
        role: Role,
        text: String,
        sentAt: Date = Date(),
        deliveryState: DeliveryState = .sent,
        emotionSnapshot: EmotionSnapshot? = nil,
        artifacts: [ShannonGeneratedArtifactDTO] = [],
        sourceAttribution: ShannonSourceAttributionDTO? = nil,
        places: [ShannonPlaceDTO] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.sentAt = sentAt
        self.deliveryState = deliveryState
        self.emotionSnapshot = emotionSnapshot
        self.artifacts = artifacts
        self.sourceAttribution = sourceAttribution
        self.places = places.isEmpty ? ShannonPlaceLinks.places(in: text) : places
    }

    public func withDeliveryState(_ deliveryState: DeliveryState) -> ConversationMessage {
        ConversationMessage(
            id: id,
            role: role,
            text: text,
            sentAt: sentAt,
            deliveryState: deliveryState,
            emotionSnapshot: emotionSnapshot,
            artifacts: artifacts,
            sourceAttribution: sourceAttribution,
            places: places
        )
    }
}

enum ShannonConversationTimelineItem: Identifiable, Equatable {
    case day(Date)
    case message(ConversationMessage)

    var id: String {
        switch self {
        case .day(let date): "day:\(date.timeIntervalSinceReferenceDate)"
        case .message(let message): "message:\(message.id.uuidString)"
        }
    }
}

enum ShannonConversationTimeline {
    static func items(
        from messages: [ConversationMessage],
        calendar: Calendar = .current
    ) -> [ShannonConversationTimelineItem] {
        var result: [ShannonConversationTimelineItem] = []
        var latestDay: Date?

        for message in messages {
            let day = calendar.startOfDay(for: message.sentAt)
            if latestDay != day {
                result.append(.day(day))
                latestDay = day
            }
            result.append(.message(message))
        }
        return result
    }
}
