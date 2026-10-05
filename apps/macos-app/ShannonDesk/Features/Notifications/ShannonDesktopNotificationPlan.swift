import Foundation
import ShannonAppCore

/// One notification of the Mac (roadmap A13): a work task waiting for a permission, work that
/// needs the owner to go on, a result, or something she said. Pressing it opens that place.
struct DesktopNotice: Equatable {
    enum Target: Equatable {
        case task(UUID)
        case thread(String)
    }

    /// Stable for one thing to tell: the same key is never notified twice.
    let key: String
    let title: String
    let body: String
    let target: Target
}

/// Which notifications to show, in the iPhone's push words (`services/api/src/pushNotifications.ts`).
/// Pure, so the rules can be tested: a state the owner has already seen is not notified, a
/// cancellation (his own decision) is not notified, and her words about the room are not quoted.
enum DesktopNotificationPlan {
    /// How many delivered keys are remembered; older ones are long past.
    static let rememberedKeys = 400

    static func notices(
        tasks: [ShannonAgentTask],
        needsNotice: (ShannonAgentTask) -> Bool,
        initiatives: [ShannonInitiativeMessageDTO]
    ) -> [DesktopNotice] {
        let work = tasks.compactMap { task -> DesktopNotice? in
            guard let attention = task.attention, attention.countsAsUnread, needsNotice(task) else { return nil }
            let key = "task:\(task.id.uuidString)|\(attention.key)"
            switch attention {
            case .approval:
                return DesktopNotice(
                    key: key,
                    title: ShannonGeneratedStrings.notificationTitleApproval,
                    body: ShannonGeneratedStrings.notificationBodyApproval(
                        title: task.title,
                        approval: task.pendingApproval?.title ?? ShannonGeneratedStrings.yousuWaitingKindApproval
                    ),
                    target: .task(task.id)
                )
            case .nextAction:
                let body = task.nextAction.map {
                    ShannonGeneratedStrings.notificationBodyNeedsOwner(title: task.title, next: $0)
                } ?? ShannonGeneratedStrings.notificationBodyNeedsOwnerNoNext(title: task.title)
                return DesktopNotice(key: key, title: ShannonGeneratedStrings.notificationTitleNeedsOwner, body: body, target: .task(task.id))
            case .completed:
                return DesktopNotice(
                    key: key,
                    title: ShannonGeneratedStrings.notificationTitleCompleted,
                    body: ShannonGeneratedStrings.notificationBodyCompleted(title: task.title),
                    target: .task(task.id)
                )
            case .failed:
                return DesktopNotice(
                    key: key,
                    title: ShannonGeneratedStrings.notificationTitleFailed,
                    body: ShannonGeneratedStrings.notificationBodyFailed(title: task.title),
                    target: .task(task.id)
                )
            case .cancelled:
                return nil
            }
        }
        let said = initiatives.filter { $0.readAt == nil }.map { message in
            DesktopNotice(
                key: "initiative:\(message.id)",
                title: ShannonGeneratedStrings.notificationTitleInitiative,
                body: message.isAboutTheRoom ? ShannonGeneratedStrings.notificationBodyRoomLook : message.content,
                target: .thread(message.threadId)
            )
        }
        return work + said
    }

    /// What to show now, and the keys to remember (nil: remember nothing yet).
    /// - Before anything was ever remembered (the first launch with notifications), what is there is
    ///   remembered without being shown, and only from a read that reached the server
    ///   (`readSucceeded`): a baseline taken from an empty or offline list would later show old things.
    /// - While notifications are not allowed nothing is shown and nothing new is remembered, so that
    ///   what arrives meanwhile is shown once they are allowed.
    /// `held`: a call is in 「友人も一緒」 (A16): nothing is posted and nothing is marked delivered, so what is new
    /// now is posted once the period ends.
    static func toPost(
        _ notices: [DesktopNotice], delivered: [String]?, readSucceeded: Bool = true, authorized: Bool = true,
        held: Bool = false
    ) -> (post: [DesktopNotice], delivered: [String]?) {
        guard let delivered else {
            guard readSucceeded else { return ([], nil) }
            return ([], Array(notices.map(\.key).suffix(rememberedKeys)))
        }
        guard authorized, !held else { return ([], delivered) }
        let known = Set(delivered)
        var seen = Set<String>()
        let post = notices.filter { !known.contains($0.key) && seen.insert($0.key).inserted }
        return (post, Array((delivered + post.map(\.key)).suffix(rememberedKeys)))
    }
}
