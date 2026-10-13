import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Whether a surface's 「見ています」 sign can be seen right now (Syzygy ADR-0011 §4.4: the camera runs only while its sign is
/// shown). Each surface that carries the sign puts an invisible anchor view in its layout; the anchor answers from the window it
/// is in, whatever presentation covers it, so a sheet added anywhere later is covered without being listed:
/// - iPhone: the anchor's view controller is the topmost presented one of its window (or inside it); a sheet or cover over it
///   hides the sign. A presentation that carries the sign itself has its own anchor, which is then the topmost.
/// - Mac: the anchor's window is on screen (visible, not minimised, not covered) and shows no sheet.
@MainActor
public enum ShannonCameraWatchSignAnchors {
    private static var anchors: [UUID: WeakAnchor] = [:]

    private struct WeakAnchor {
        weak var view: PlatformView?
    }

    static func register(_ view: PlatformView, for id: UUID) {
        anchors[id] = WeakAnchor(view: view)
    }

    static func remove(_ id: UUID) {
        anchors[id] = nil
    }

    /// True only when the anchor of `id` is in a window and nothing covers it. An unknown or detached anchor is not visible.
    public static func visible(_ id: UUID) -> Bool {
        guard let view = anchors[id]?.view, let window = view.window else { return false }
        return uncovered(view, in: window)
    }

#if canImport(UIKit)
    typealias PlatformView = UIView

    private static func uncovered(_ view: UIView, in window: UIWindow) -> Bool {
        guard !window.isHidden, let host = controller(of: view), var top = window.rootViewController else { return false }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        return ShannonCameraWatchSignVisibility.isWithin(host, top: top, parent: { $0.parent })
    }

    private static func controller(of view: UIView) -> UIViewController? {
        var responder: UIResponder? = view
        while let next = responder?.next {
            if let controller = next as? UIViewController { return controller }
            responder = next
        }
        return nil
    }
#elseif canImport(AppKit)
    typealias PlatformView = NSView

    private static func uncovered(_ view: NSView, in window: NSWindow) -> Bool {
        window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible) && window.attachedSheet == nil
    }
#endif
}

/// The pure part of the iPhone rule, testable without a window: the sign's controller is the topmost presented controller or a
/// child inside it (a navigation or tab container's child).
public enum ShannonCameraWatchSignVisibility {
    public static func isWithin<Node: AnyObject>(_ host: Node, top: Node, parent: (Node) -> Node?) -> Bool {
        var node: Node? = host
        while let current = node {
            if current === top { return true }
            node = parent(current)
        }
        return false
    }
}

/// The invisible view that tells `ShannonCameraWatchSignAnchors` where a sign is.
struct ShannonCameraWatchSignAnchorView: View {
    let id: UUID

    var body: some View {
        Representable(id: id)
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .allowsHitTesting(false)
    }

#if canImport(UIKit)
    private struct Representable: UIViewRepresentable {
        let id: UUID
        func makeUIView(context: Context) -> UIView {
            let view = UIView(frame: .zero)
            view.isUserInteractionEnabled = false
            ShannonCameraWatchSignAnchors.register(view, for: id)
            return view
        }
        func updateUIView(_ view: UIView, context: Context) { ShannonCameraWatchSignAnchors.register(view, for: id) }
        static func dismantleUIView(_ view: UIView, coordinator: ()) {}
    }
#elseif canImport(AppKit)
    private struct Representable: NSViewRepresentable {
        let id: UUID
        func makeNSView(context: Context) -> NSView {
            let view = NSView(frame: .zero)
            ShannonCameraWatchSignAnchors.register(view, for: id)
            return view
        }
        func updateNSView(_ view: NSView, context: Context) { ShannonCameraWatchSignAnchors.register(view, for: id) }
    }
#endif
}
