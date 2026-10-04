import Foundation

/// What the iPhone's top-left button says about the entries behind it
/// (docs/product/information-architecture.md, 「いつも見える所に置くもの」): a red dot while
/// something is unread or waits for the owner. Pure, so the words can be tested.
enum ShannonEntryMarks {
    static func accessibilityValue(unread: Int, waiting: Int) -> String {
        var parts: [String] = []
        if unread > 0 { parts.append("未確認\(unread)件") }
        if waiting > 0 { parts.append("シャノンが待っていること\(waiting)件") }
        return parts.isEmpty ? "未確認なし" : parts.joined(separator: "、")
    }
}
