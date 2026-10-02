import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif

/// The two halves of 「ようす」.
public enum ShannonYousuSegment: String, CaseIterable, Identifiable, Sendable {
    case now
    case ops

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .now: "シャノンのいま"
        case .ops: "運用"
        }
    }

    /// Where the last segment the owner looked at is remembered, on this device only.
    public static let storageKey = "shannon.yousu.segment"
}

/// `shannon://yousu`, `shannon://yousu/now` and `shannon://yousu/ops` open 「ようす」.
/// Without a segment the last one the owner looked at is shown.
public enum ShannonYousuLink {
    public struct Request: Equatable, Sendable {
        public let segment: ShannonYousuSegment?

        public init(segment: ShannonYousuSegment?) {
            self.segment = segment
        }
    }

    /// The request a link stands for, or nil when the link is something else (a pairing link, for one).
    public static func request(from url: URL) -> Request? {
        guard url.scheme?.lowercased() == "shannon", url.host()?.lowercased() == "yousu" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count <= 1 else { return nil }
        guard let name = parts.first else { return Request(segment: nil) }
        return ShannonYousuSegment(rawValue: name.lowercased()).map { Request(segment: $0) }
    }

    public static func url(_ segment: ShannonYousuSegment? = nil) -> URL {
        URL(string: "shannon://yousu" + (segment.map { "/\($0.rawValue)" } ?? ""))!
    }

    /// Opens 「ようす」 for a link. Returns false for any other link, which the caller handles as before.
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

/// The two models of 「ようす」, owned by the conversation root so that a report read once
/// is still there when the list is opened again.
@MainActor
@Observable
public final class ShannonYousuModel {
    public let ops: ShannonOpsModel
    public let now: ShannonNowModel

    public init(scopeKey: String = "local-owner", client: (any ShannonYousuServing)? = ShannonAPIClient()) {
        ops = ShannonOpsModel(scopeKey: scopeKey, client: client)
        now = ShannonNowModel(scopeKey: scopeKey, client: client)
    }

    /// The mark on the 「ようす」 tile: something in 運用 deserves a look.
    public var needsAttention: Bool { ops.needsAttention }
}
