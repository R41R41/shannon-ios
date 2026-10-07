import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif

/// Links into 「シャノン › ようす」 and 「設定 › 管理 › 運用」:
/// - `shannon://yousu` and `shannon://yousu/now` open ようす (シャノンのいま);
/// - `shannon://admin/ops` opens 運用, and so does the older `shannon://yousu/ops`, from the time
///   when 運用 was a half of ようす (decision 2026-10-03: 運用 lives in 設定 › 管理).
public enum ShannonYousuLink {
    public enum Request: Equatable, Sendable {
        /// 「シャノン › ようす」
        case yousu
        /// 「設定 › 管理 › 運用」
        case ops
    }

    /// The request a link stands for, or nil when the link is something else (a pairing link, for one).
    public static func request(from url: URL) -> Request? {
        guard url.scheme?.lowercased() == "shannon" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }.map { $0.lowercased() }
        switch url.host()?.lowercased() {
        case "yousu":
            switch parts {
            case [], ["now"]: return .yousu
            case ["ops"]: return .ops
            default: return nil
            }
        case "admin":
            return parts == ["ops"] ? .ops : nil
        default:
            return nil
        }
    }

    public static func url(_ request: Request) -> URL {
        switch request {
        case .yousu: URL(string: "shannon://yousu")!
        case .ops: URL(string: "shannon://admin/ops")!
        }
    }

    /// Opens the place of a link. Returns false for any other link, which the caller handles as before.
    @MainActor
    public static func open(_ url: URL) -> Bool {
        guard let request = request(from: url) else { return false }
        pending = request
        NotificationCenter.default.post(name: .shannonYousuLinkOpened, object: nil)
        return true
    }

    /// The request of a link that arrived before the conversation view was on screen.
    @MainActor
    public static func takePending() -> Request? {
        defer { pending = nil }
        return pending
    }

    @MainActor private static var pending: Request?
}

/// Whether the app is in front, asked of the system itself.
@MainActor
enum ShannonYousuForeground {
    static var isActive: Bool {
#if canImport(UIKit) && !os(watchOS)
        UIApplication.shared.applicationState == .active
#else
        true
#endif
    }
}

public extension Notification.Name {
    static let shannonYousuLinkOpened = Notification.Name("ShannonYousuLinkOpened")
}

/// The models of ようす and 運用, owned by the conversation root so that a report read once
/// is still there when a page is opened again.
@MainActor
@Observable
public final class ShannonYousuModel {
    public let ops: ShannonOpsModel
    public let now: ShannonNowModel
    /// 「学び」 (Syzygy ADR-0008 §13): her skills, 手応え and the value table's version.
    public let learning: ShannonLearningModel
    /// The page of ようす on screen: いま／学び／気分. Kept here so it is the same when ようす is opened again.
    public var tab: ShannonYousuTab = .now

    /// `defaults` keeps, per scope, only whether a report of 運用 has ever arrived (its mark's rule).
    public init(scopeKey: String = "local-owner", client: (any ShannonYousuServing)? = ShannonAPIClient(), defaults: UserDefaults? = nil) {
        ops = ShannonOpsModel(scopeKey: scopeKey, client: client, defaults: defaults)
        now = ShannonNowModel(scopeKey: scopeKey, client: client)
        learning = ShannonLearningModel(scopeKey: scopeKey, client: client)
    }

    /// The tabs offered: 学び only once a read of it has answered on this device (it is the owner's alone), never before.
    public var tabs: [ShannonYousuTab] {
        learning.isOffered || (tab == .learning && !learning.isUnavailable) ? ShannonYousuTab.allCases : [.now, .mood]
    }

    /// The 運用 mark (top-left button, 設定 tile, 運用 row): something in 運用 deserves a look.
    public var needsAttention: Bool { ops.needsAttention }
}
