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
        /// A core feeling that borrows `expression`'s face (得意げ, 慌てている, 申し訳なさそう).
        public let feeling: ShannonFeelingDTO?
        /// The reply's own kind as the server named it (`messageEmotion.kind`). Kept as text, also when this
        /// build has no icon for it, so a later build can show it; read it through `face`.
        public let kind: String?
        /// The face this reply was shown with (`messageEmotion.presentationId`, Syzygy ADR-0013 D17), kept per reply so the
        /// history shows how she felt then. Nil from older servers and older caches: the usual face.
        public let presentationId: String?
        public let stateVersion: Int

        public init(
            valence: Double,
            arousal: Double,
            openness: Double,
            expression: ShannonExpressionDTO,
            feeling: ShannonFeelingDTO? = nil,
            kind: String? = nil,
            presentationId: String? = nil,
            stateVersion: Int
        ) {
            self.valence = valence
            self.arousal = arousal
            self.openness = openness
            self.expression = expression
            self.feeling = feeling
            self.kind = kind
            self.presentationId = presentationId
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
    /// The server turn this message belongs to, when known.
    public let turnID: String?
    /// What Shannon took in from this turn. Empty until the server has recorded it.
    public let captures: [ShannonTurnCaptureDTO]
    public let reminder: ShannonReminderDTO?
    /// A piece of her study this message is about.
    public let studyPiece: ShannonStudyPieceLinkDTO?
    public let feedback: ShannonFeedbackDTO?
    /// The server's id of this message, once the Talk was read from the server (rich chat: reactions target it).
    public let serverID: String?
    /// The report card of finished work he asked for; only the owner alone is sent one.
    public let reportCard: ShannonReportCardDTO?
    /// The owner's reactions, oldest first, as the server last sent them.
    public let reactions: [String]

    public init(
        id: UUID = UUID(),
        role: Role,
        text: String,
        sentAt: Date = Date(),
        deliveryState: DeliveryState = .sent,
        emotionSnapshot: EmotionSnapshot? = nil,
        artifacts: [ShannonGeneratedArtifactDTO] = [],
        sourceAttribution: ShannonSourceAttributionDTO? = nil,
        places: [ShannonPlaceDTO] = [],
        turnID: String? = nil,
        captures: [ShannonTurnCaptureDTO] = [],
        reminder: ShannonReminderDTO? = nil,
        studyPiece: ShannonStudyPieceLinkDTO? = nil,
        feedback: ShannonFeedbackDTO? = nil,
        serverID: String? = nil,
        reportCard: ShannonReportCardDTO? = nil,
        reactions: [String] = []
    ) {
        self.serverID = serverID
        self.reportCard = reportCard
        self.reactions = reactions
        self.feedback = feedback
        self.studyPiece = studyPiece
        self.turnID = turnID
        self.captures = captures
        self.reminder = reminder
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
            places: places,
            turnID: turnID,
            captures: captures,
            reminder: reminder,
            studyPiece: studyPiece,
            feedback: feedback,
            serverID: serverID,
            reportCard: reportCard,
            reactions: reactions
        )
    }

    public func with(captures: [ShannonTurnCaptureDTO], reminder: ShannonReminderDTO?) -> ConversationMessage {
        ConversationMessage(
            id: id,
            role: role,
            text: text,
            sentAt: sentAt,
            deliveryState: deliveryState,
            emotionSnapshot: emotionSnapshot,
            artifacts: artifacts,
            sourceAttribution: sourceAttribution,
            places: places,
            turnID: turnID,
            captures: captures,
            reminder: reminder,
            studyPiece: studyPiece,
            feedback: feedback,
            serverID: serverID,
            reportCard: reportCard,
            reactions: reactions
        )
    }

    /// The same message with the server's current feedback target; everything else kept.
    public func with(feedback: ShannonFeedbackDTO?) -> ConversationMessage {
        ConversationMessage(
            id: id, role: role, text: text, sentAt: sentAt, deliveryState: deliveryState, emotionSnapshot: emotionSnapshot,
            artifacts: artifacts, sourceAttribution: sourceAttribution, places: places, turnID: turnID, captures: captures,
            reminder: reminder, studyPiece: studyPiece, feedback: feedback, serverID: serverID, reportCard: reportCard, reactions: reactions
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
