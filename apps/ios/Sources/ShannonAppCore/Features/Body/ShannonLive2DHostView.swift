import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The place on a screen where the shared Live2D web view is shown. It owns no web view:
/// it tells the stage when it is on screen, and the stage moves the one web view into it.
/// One-finger touches go to the page; pinch and two-finger drag are handled here and
/// reach the page as a layout.
struct ShannonLive2DHostView {
    let hostID: UUID
    let layout: ShannonLive2DLayout
    let touchEnabled: Bool
    /// Non-nil where the owner may scale and move her (the body screen).
    var onLayoutChange: ((ShannonLive2DLayout) -> Void)?
}

#if canImport(UIKit)
extension ShannonLive2DHostView: UIViewRepresentable {
    func makeUIView(context: Context) -> ShannonLive2DContainerView {
        let view = ShannonLive2DContainerView(hostID: hostID)
        view.configure(layout: layout, touchEnabled: touchEnabled, onLayoutChange: onLayoutChange)
        return view
    }

    func updateUIView(_ view: ShannonLive2DContainerView, context: Context) {
        view.configure(layout: layout, touchEnabled: touchEnabled, onLayoutChange: onLayoutChange)
    }

    static func dismantleUIView(_ view: ShannonLive2DContainerView, coordinator: ()) {
        ShannonLive2DStage.shared.detach(host: view.hostID)
    }
}

final class ShannonLive2DContainerView: UIView, UIGestureRecognizerDelegate {
    let hostID: UUID
    private var layout = ShannonLive2DLayout()
    private var touchEnabled = true
    private var onLayoutChange: ((ShannonLive2DLayout) -> Void)?
    private var gestureStart: ShannonLive2DLayout?
    private lazy var pinch = UIPinchGestureRecognizer(target: self, action: #selector(gestureChanged))
    private lazy var pan: UIPanGestureRecognizer = {
        let recognizer = UIPanGestureRecognizer(target: self, action: #selector(gestureChanged))
        recognizer.minimumNumberOfTouches = 2
        recognizer.maximumNumberOfTouches = 2
        return recognizer
    }()

    init(hostID: UUID) {
        self.hostID = hostID
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        clipsToBounds = true
        // VoiceOver reads the SwiftUI wrapper; the web content stays out of the accessibility tree.
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        pinch.delegate = self
        pan.delegate = self
        addGestureRecognizer(pinch)
        addGestureRecognizer(pan)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(layout: ShannonLive2DLayout, touchEnabled: Bool, onLayoutChange: ((ShannonLive2DLayout) -> Void)?) {
        self.layout = layout
        self.touchEnabled = touchEnabled
        self.onLayoutChange = onLayoutChange
        pinch.isEnabled = onLayoutChange != nil
        pan.isEnabled = onLayoutChange != nil
        ShannonLive2DStage.shared.update(host: hostID, layout: layout, touchEnabled: touchEnabled)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            ShannonLive2DStage.shared.detach(host: hostID)
        } else {
            ShannonLive2DStage.shared.attach(host: hostID, container: self, layout: layout, touchEnabled: touchEnabled)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        ShannonLive2DStage.shared.hostDidLayout(hostID)
    }

    /// A finger on a resting figure (Reduce Motion, Low Power Mode) wakes it before the page sees the touch.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let view = super.hitTest(point, with: event)
        if view != nil, touchEnabled, event?.type == .touches { ShannonLive2DStage.shared.noteActivity() }
        return view
    }

    @objc private func gestureChanged(_ recognizer: UIGestureRecognizer) {
        guard let onLayoutChange else { return }
        let active: (UIGestureRecognizer) -> Bool = { $0.state == .began || $0.state == .changed }
        if recognizer.state == .began, gestureStart == nil { gestureStart = layout }
        guard let start = gestureStart else { return }
        let translation = active(pan) ? pan.translation(in: self) : .zero
        let next = start.adjusted(
            scaleBy: active(pinch) ? Double(pinch.scale) : 1,
            movedBy: CGSize(width: translation.x, height: translation.y),
            in: bounds.size
        )
        if next != layout {
            layout = next
            ShannonLive2DStage.shared.update(host: hostID, layout: next, touchEnabled: touchEnabled)
            onLayoutChange(next)
        }
        if !active(pinch), !active(pan) { gestureStart = nil }
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool { true }
}
#elseif canImport(AppKit)
extension ShannonLive2DHostView: NSViewRepresentable {
    func makeNSView(context: Context) -> ShannonLive2DContainerView {
        let view = ShannonLive2DContainerView(hostID: hostID)
        view.configure(layout: layout, touchEnabled: touchEnabled, onLayoutChange: onLayoutChange)
        return view
    }

    func updateNSView(_ view: ShannonLive2DContainerView, context: Context) {
        view.configure(layout: layout, touchEnabled: touchEnabled, onLayoutChange: onLayoutChange)
    }

    static func dismantleNSView(_ view: ShannonLive2DContainerView, coordinator: ()) {
        ShannonLive2DStage.shared.detach(host: view.hostID)
    }
}

/// The Mac host: the pointer goes to the page (its touch thresholds were tuned for a mouse),
/// and a trackpad pinch scales her. Moving her is not offered on the Mac.
final class ShannonLive2DContainerView: NSView {
    let hostID: UUID
    private var layout = ShannonLive2DLayout()
    private var touchEnabled = true
    private var onLayoutChange: ((ShannonLive2DLayout) -> Void)?
    private var gestureStart: ShannonLive2DLayout?
    private lazy var magnify = NSMagnificationGestureRecognizer(target: self, action: #selector(magnified))

    init(hostID: UUID) {
        self.hostID = hostID
        super.init(frame: .zero)
        addGestureRecognizer(magnify)
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(layout: ShannonLive2DLayout, touchEnabled: Bool, onLayoutChange: ((ShannonLive2DLayout) -> Void)?) {
        self.layout = layout
        self.touchEnabled = touchEnabled
        self.onLayoutChange = onLayoutChange
        magnify.isEnabled = onLayoutChange != nil
        ShannonLive2DStage.shared.update(host: hostID, layout: layout, touchEnabled: touchEnabled)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            ShannonLive2DStage.shared.detach(host: hostID)
        } else {
            ShannonLive2DStage.shared.attach(host: hostID, container: self, layout: layout, touchEnabled: touchEnabled)
        }
    }

    override func layout() {
        super.layout()
        ShannonLive2DStage.shared.hostDidLayout(hostID)
    }

    /// A click on a resting figure wakes it before the page sees the pointer.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let view = super.hitTest(point)
        if view != nil, touchEnabled, ShannonLive2DStage.shared.isResting { ShannonLive2DStage.shared.noteActivity() }
        return view
    }

    @objc private func magnified(_ recognizer: NSMagnificationGestureRecognizer) {
        guard let onLayoutChange else { return }
        if recognizer.state == .began { gestureStart = layout }
        guard let start = gestureStart else { return }
        let next = start.adjusted(scaleBy: 1 + Double(recognizer.magnification), movedBy: .zero, in: bounds.size)
        if next != layout {
            layout = next
            ShannonLive2DStage.shared.update(host: hostID, layout: next, touchEnabled: touchEnabled)
            onLayoutChange(next)
        }
        if recognizer.state == .ended || recognizer.state == .cancelled || recognizer.state == .failed { gestureStart = nil }
    }
}
#endif
