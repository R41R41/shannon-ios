import SwiftUI
#if canImport(UIKit)
import UIKit
import UIKit.UIGestureRecognizerSubclass
#elseif canImport(AppKit)
import AppKit
#endif

/// The place on a screen where the shared Live2D web view is shown. It owns no web view:
/// it tells the stage when it is on screen, and the stage moves the one web view into it.
/// One-finger touches go to the page; pinch and two-finger drag are handled here and
/// reach the page as a layout.
struct ShannonLive2DHostView {
    let hostID: UUID
    let priority: ShannonLive2DHostPriority
    let layout: ShannonLive2DLayout
    let touchEnabled: Bool
    /// Non-nil where the owner may scale and move her (the body screen).
    var onLayoutChange: ((ShannonLive2DLayout) -> Void)?
}

#if canImport(UIKit)
extension ShannonLive2DHostView: UIViewRepresentable {
    func makeUIView(context: Context) -> ShannonLive2DContainerView {
        let view = ShannonLive2DContainerView(hostID: hostID, priority: priority)
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
    private let priority: ShannonLive2DHostPriority
    private var layout = ShannonLive2DLayout()
    private var touchEnabled = true
    private var onLayoutChange: ((ShannonLive2DLayout) -> Void)?
    private var tracker = ShannonLive2DGestureTracker()
    /// The screen's scrolling, held while a finger that landed on her is down (`ShannonFigureScrollHold`).
    private var scrollHold = ShannonFigureScrollHold()
    private weak var heldScroll: UIScrollView?
    private lazy var pinch = UIPinchGestureRecognizer(target: self, action: #selector(gestureChanged))
    private lazy var pan: UIPanGestureRecognizer = {
        let recognizer = UIPanGestureRecognizer(target: self, action: #selector(gestureChanged))
        recognizer.minimumNumberOfTouches = 2
        recognizer.maximumNumberOfTouches = 2
        return recognizer
    }()

    init(hostID: UUID, priority: ShannonLive2DHostPriority) {
        self.hostID = hostID
        self.priority = priority
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
        let fingers = ShannonFingerObserver { [weak self] down in
            ShannonLive2DStage.shared.setFingerDown(down)
            self?.fingersChanged(down: down)
        }
        fingers.delegate = self
        addGestureRecognizer(fingers)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(layout: ShannonLive2DLayout, touchEnabled: Bool, onLayoutChange: ((ShannonLive2DLayout) -> Void)?) {
        self.layout = layout
        self.touchEnabled = touchEnabled
        self.onLayoutChange = onLayoutChange
        pinch.isEnabled = onLayoutChange != nil
        pan.isEnabled = onLayoutChange != nil
        if !touchEnabled { fingersChanged(down: false) }
        ShannonLive2DStage.shared.update(host: hostID, layout: layout, touchEnabled: touchEnabled)
    }

    /// In a screen that scrolls, a finger on her holds the scrolling until it lifts: the stroke reaches the page instead of
    /// being taken (and cancelled) by the scroll. The scroll is always given back: on the lift, when touch is switched off,
    /// and when she leaves the window.
    private func fingersChanged(down: Bool) {
        let scroll = down ? (ShannonFigureScrollHold.applies(to: priority) ? enclosingScrollView : nil) : heldScroll
        guard let enabled = scrollHold.fingers(down: down, touchEnabled: touchEnabled, inScroll: scroll != nil) else { return }
        if !enabled { heldScroll = scroll }
        heldScroll?.panGestureRecognizer.isEnabled = enabled
        if enabled { heldScroll = nil }
    }

    private var enclosingScrollView: UIScrollView? {
        var view = superview
        while let current = view {
            if let scroll = current as? UIScrollView { return scroll }
            view = current.superview
        }
        return nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            fingersChanged(down: false)
            ShannonLive2DStage.shared.detach(host: hostID)
        } else {
            ShannonLive2DStage.shared.attach(host: hostID, container: self, priority: priority, layout: layout, touchEnabled: touchEnabled)
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
        var factor = 1.0
        var movement = CGSize.zero
        switch (recognizer.state, recognizer === pinch) {
        case (.began, true): tracker.beginPinch()
        case (.began, false): tracker.beginPan()
        case (.changed, true): factor = tracker.pinch(scale: Double(pinch.scale))
        case (.changed, false):
            let translation = pan.translation(in: self)
            movement = tracker.pan(translation: CGSize(width: translation.x, height: translation.y))
        default: return // A finger lifting changes nothing: the layout stays where the gesture left it.
        }
        let next = layout.adjusted(scaleBy: factor, movedBy: movement, in: bounds.size)
        guard next != layout else { return }
        layout = next
        ShannonLive2DStage.shared.update(host: hostID, layout: next, touchEnabled: touchEnabled)
        onLayoutChange(next)
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool { true }
}

/// Watches whether any finger is on the figure, and never recognises: the touches go on to the page.
private final class ShannonFingerObserver: UIGestureRecognizer {
    private let onChange: (Bool) -> Void
    private var fingers = 0

    init(onChange: @escaping (Bool) -> Void) {
        self.onChange = onChange
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if fingers == 0 { onChange(true) }
        fingers += touches.count
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { lifted(touches.count) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { lifted(touches.count) }

    override func reset() {
        if fingers > 0 { onChange(false) }
        fingers = 0
    }

    private func lifted(_ count: Int) {
        fingers = max(0, fingers - count)
        guard fingers == 0 else { return }
        onChange(false)
        state = .failed
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
#elseif canImport(AppKit)
extension ShannonLive2DHostView: NSViewRepresentable {
    func makeNSView(context: Context) -> ShannonLive2DContainerView {
        let view = ShannonLive2DContainerView(hostID: hostID, priority: priority)
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

/// The Mac host: the pointer goes to the page (its touch thresholds were tuned for a mouse), so a
/// click or a drag on her is a touch. Her size and place are the wide screen's (A15): a trackpad pinch
/// or a scroll with ⌘ scales her, and a scroll moves her.
final class ShannonLive2DContainerView: NSView {
    let hostID: UUID
    private let priority: ShannonLive2DHostPriority
    private var figureLayout = ShannonLive2DLayout()
    private var touchEnabled = true
    private var onLayoutChange: ((ShannonLive2DLayout) -> Void)?
    private var gestureStart: ShannonLive2DLayout?
    private lazy var magnify = NSMagnificationGestureRecognizer(target: self, action: #selector(magnified))

    init(hostID: UUID, priority: ShannonLive2DHostPriority) {
        self.hostID = hostID
        self.priority = priority
        super.init(frame: .zero)
        addGestureRecognizer(magnify)
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(layout: ShannonLive2DLayout, touchEnabled: Bool, onLayoutChange: ((ShannonLive2DLayout) -> Void)?) {
        figureLayout = layout
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
            ShannonLive2DStage.shared.attach(host: hostID, container: self, priority: priority, layout: figureLayout, touchEnabled: touchEnabled)
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

    override func scrollWheel(with event: NSEvent) {
        guard let onLayoutChange, touchEnabled else { return super.scrollWheel(with: event) }
        let next = Self.scrolled(
            figureLayout, deltaX: event.scrollingDeltaX, deltaY: event.scrollingDeltaY,
            precise: event.hasPreciseScrollingDeltas, inverted: event.isDirectionInvertedFromDevice,
            scales: event.modifierFlags.contains(.command), in: bounds.size
        )
        guard next != figureLayout else { return }
        figureLayout = next
        ShannonLive2DStage.shared.update(host: hostID, layout: next, touchEnabled: touchEnabled)
        onLayoutChange(next)
    }

    /// A scroll moves her the way the fingers (or the wheel) go, whatever the owner's scroll direction
    /// setting: AppKit's delta follows the content, so it is turned back when it is not inverted from the
    /// device. With ⌘, moving up makes her larger. The page's y grows downwards.
    static func scrolled(
        _ layout: ShannonLive2DLayout, deltaX: CGFloat, deltaY: CGFloat, precise: Bool, inverted: Bool,
        scales: Bool, in bounds: CGSize
    ) -> ShannonLive2DLayout {
        let sign: CGFloat = inverted ? 1 : -1
        let fingerX = deltaX * sign
        let fingerY = deltaY * sign
        if scales {
            let step = precise ? fingerY / 200 : fingerY / 20
            return layout.adjusted(scaleBy: max(0.5, 1 - Double(step)), movedBy: .zero, in: bounds)
        }
        let factor: CGFloat = precise ? 1 : 8
        return layout.adjusted(scaleBy: 1, movedBy: CGSize(width: fingerX * factor, height: fingerY * factor), in: bounds)
    }

    @objc private func magnified(_ recognizer: NSMagnificationGestureRecognizer) {
        guard let onLayoutChange else { return }
        if recognizer.state == .began { gestureStart = figureLayout }
        guard let start = gestureStart else { return }
        let next = start.adjusted(scaleBy: 1 + Double(recognizer.magnification), movedBy: .zero, in: bounds.size)
        if next != figureLayout {
            figureLayout = next
            ShannonLive2DStage.shared.update(host: hostID, layout: next, touchEnabled: touchEnabled)
            onLayoutChange(next)
        }
        if recognizer.state == .ended || recognizer.state == .cancelled || recognizer.state == .failed { gestureStart = nil }
    }
}
#endif
