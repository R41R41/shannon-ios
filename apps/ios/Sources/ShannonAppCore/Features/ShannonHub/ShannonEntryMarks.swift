import Foundation

/// What the iPhone's top-left button says about the entries behind it
/// (docs/product/information-architecture.md, 「いつも見える所に置くもの」): a red dot while
/// something is unread or waits for the owner, and an orange triangle while 運用 deserves a
/// look. Pure, so the words can be tested; VoiceOver hears the same as the eye sees.
enum ShannonEntryMarks {
    /// What waits for him, for the top-left button's words: a work task already said as unread is not said again.
    static func waitingNotUnread(_ waiting: [ShannonNowWaitingItem], unreadTaskIDs: Set<String>) -> Int {
        waiting.filter { !($0.kind == .approval && unreadTaskIDs.contains($0.id)) }.count
    }

    static func accessibilityValue(unread: Int, waiting: Int, opsAttention: String? = nil) -> String {
        var parts: [String] = []
        if unread > 0 { parts.append("未確認\(unread)件") }
        if waiting > 0 { parts.append(ShannonGeneratedStrings.entryWaiting(count: String(waiting))) }
        if let opsAttention { parts.append(ShannonGeneratedStrings.entryOpsReason(reason: opsAttention)) }
        return parts.isEmpty ? "未確認なし" : parts.joined(separator: "、")
    }
}
